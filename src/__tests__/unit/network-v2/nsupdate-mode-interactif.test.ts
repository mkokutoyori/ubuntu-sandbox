/**
 * `nsupdate` sans argument ouvre une invite, comme le vrai binaire.
 *
 * La forme non interactive — script sur l'entree standard ou dans un
 * fichier — existait ; celle que tout tutoriel montre, l'invite `>` ou
 * l'on compose puis `send`, non. Le sous-shell REUTILISE l'analyseur de
 * la commande (`NsupdateScript.ts`), sans quoi les deux formes
 * finiraient par accepter deux langages differents.
 *
 * Le laboratoire est un vrai reseau et la verification passe par une
 * requete DNS reelle, comme pour la forme scriptee.
 *
 * Discrimine par `git stash` de `LinuxTerminalSession.ts`, ou vit
 * l'interception : 8 des 9 cas tombent. Le seul qui passe des deux cotes
 * est le TEMOIN — `nsupdate <fichier>` doit justement NE PAS ouvrir
 * d'invite, et prend le chemin scripte des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { TsigAlgorithm } from '@/network/dns/tsig/Tsig';
import type { UpdateSecurityPolicy } from '@/network/dns/update/UpdateResponder';

const ORIGIN = 'example.com';
const SERVEUR = '10.0.0.1';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

function labo(updatePolicy: UpdateSecurityPolicy = 'none') {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const hote = new LinuxServer('linux-server', 'ns1', 0, 0);
  const poste = new LinuxPC('linux-pc', 'poste', 0, 0);
  const masque = new SubnetMask('255.255.255.0');
  [hote, poste].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  hote.getPorts()[0].configureIP(new IPAddress(SERVEUR), masque);
  poste.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), masque);

  const zone = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.10'));
  const serveur = new PrimaryZoneAgent(hote, zone, { updatePolicy });
  serveur.start();

  const session = new LinuxTerminalSession('t1', poste);
  return { poste, serveur, session };
}

async function taper(session: LinuxTerminalSession, ligne: string): Promise<void> {
  const s = session as unknown as {
    setInput(v: string): void; setInputBuf(v: string): void;
    handleKey(e: KeyEvent): boolean;
  };
  s.setInput(ligne);
  s.setInputBuf(ligne);
  s.handleKey(key('Enter'));
  await flush();
}

const invite = (session: LinuxTerminalSession) =>
  (session as unknown as { activeSubShell: { getPrompt(): string } | null }).activeSubShell;

const texte = (session: LinuxTerminalSession) =>
  (session as unknown as { lines: { text: string }[] }).lines.map(l => l.text).join('\n');

describe('l invite de nsupdate', () => {
  it('`nsupdate` seul ouvre un sous-shell, et `quit` en sort', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate');
    expect(invite(session)?.getPrompt()).toBe('> ');

    await taper(session, 'quit');
    expect(invite(session)).toBeNull();
  });

  it('TEMOIN — avec un fichier en argument, la commande ordinaire s execute', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate /tmp/rien.txt');
    expect(invite(session)).toBeNull();
    expect(texte(session)).toContain("can't open");
  });

  it('composer puis `send` ecrit vraiment dans la zone', async () => {
    const { poste, session } = labo();
    await taper(session, 'nsupdate');
    await taper(session, `server ${SERVEUR}`);
    await taper(session, `zone ${ORIGIN}`);
    await taper(session, `update add poste.${ORIGIN} 300 A 10.0.0.100`);
    await taper(session, 'send');
    await taper(session, 'quit');

    expect(await poste.executeCommand(`dig +short @${SERVEUR} poste.${ORIGIN} A`))
      .toContain('10.0.0.100');
  });

  it('`show` liste ce qui est en attente, et `send` vide la file', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate');
    await taper(session, `server ${SERVEUR}`);
    await taper(session, `update add poste.${ORIGIN} 300 A 10.0.0.100`);
    await taper(session, 'show');
    expect(texte(session)).toContain('update add');

    await taper(session, 'send');
    await taper(session, 'show');
    expect(texte(session)).toContain('(nothing to send)');
  });

  it('`answer` rend le code du dernier envoi', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate');
    await taper(session, `server ${SERVEUR}`);
    await taper(session, `prereq nxdomain www.${ORIGIN}`);
    await taper(session, `update add www.${ORIGIN} 300 A 10.0.0.66`);
    await taper(session, 'send');
    await taper(session, 'answer');

    expect(texte(session)).toContain('YXDOMAIN');
  });

  it('un mot inconnu est refuse sans quitter l invite', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate');
    await taper(session, 'zorglub');
    expect(texte(session)).toContain("unknown command 'zorglub'");
    expect(invite(session)?.getPrompt()).toBe('> ');
  });

  it('sans `server`, `send` refuse au lieu de deviner', async () => {
    const { session } = labo();
    await taper(session, 'nsupdate');
    await taper(session, `update add poste.${ORIGIN} 300 A 10.0.0.100`);
    await taper(session, 'send');
    expect(texte(session)).toContain('no server given');
  });

  it('`-y` porte la cle jusqu a l invite', async () => {
    const { poste, serveur, session } = labo('secure');
    serveur.getTsigKeyring().add({
      name: 'cle-labo', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage',
    });

    await taper(session, 'nsupdate -y hmac-sha256:cle-labo:secret-partage');
    await taper(session, `server ${SERVEUR}`);
    await taper(session, `zone ${ORIGIN}`);
    await taper(session, `update add poste.${ORIGIN} 300 A 10.0.0.100`);
    await taper(session, 'send');

    expect(await poste.executeCommand(`dig +short @${SERVEUR} poste.${ORIGIN} A`))
      .toContain('10.0.0.100');
  });

  it('sans la cle, la meme zone securisee refuse', async () => {
    const { poste, serveur, session } = labo('secure');
    serveur.getTsigKeyring().add({
      name: 'cle-labo', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage',
    });

    await taper(session, 'nsupdate');
    await taper(session, `server ${SERVEUR}`);
    await taper(session, `zone ${ORIGIN}`);
    await taper(session, `update add poste.${ORIGIN} 300 A 10.0.0.100`);
    await taper(session, 'send');

    expect(texte(session)).toContain('NOTAUTH');
    expect(await poste.executeCommand(`dig +short @${SERVEUR} poste.${ORIGIN} A`))
      .not.toContain('10.0.0.100');
  });
});
