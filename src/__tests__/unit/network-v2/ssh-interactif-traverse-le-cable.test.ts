/**
 * Phase 5 de la refonte SSH — le critère d'acceptation de l'audit pour le
 * cas d'usage le plus visible du produit : une session `ssh` INTERACTIVE
 * doit faire circuler des paquets, et chaque commande tapée dedans doit
 * repartir sur le fil.
 *
 * Le constat #1 de l'audit était qu'après authentification, le terminal
 * était relié directement à l'objet `Equipment` distant : la session
 * n'animait aucun paquet et n'apparaissait dans aucune capture de
 * transit. La mesure ci-dessous est donc la seule qui tranche — les
 * compteurs de trames du câble intermédiaire, relevés autour d'UNE
 * commande tapée dans la session déjà ouverte. Vérifier seulement que la
 * sortie est correcte ne distinguerait rien : le contournement donnait
 * exactement la même sortie.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

const CLI = '10.95.0.10';
const SRV = '10.95.0.20';
const MASK = new SubnetMask('255.255.255.0');
const MDP = 'Secret123!';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false } as KeyEvent;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  const fg = session.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

function frames(c: Cable): number {
  const s = c.getStats() as { framesTransmitted?: number; frames?: number };
  return s.framesTransmitted ?? s.frames ?? 0;
}

function linesOf(session: TerminalSession): string[] {
  return session.lines.map((l) => l.text);
}

async function lab() {
  const client = new LinuxPC('linux-pc', 'CLI');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const c1 = new Cable('c1');
  c1.connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  client.getPorts()[0].configureIP(new IPAddress(CLI), MASK);
  server.getPorts()[0].configureIP(new IPAddress(SRV), MASK);
  client.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await server.executeCommand(`sh -c 'echo "alice:${MDP}" | chpasswd'`);
  return { client, server, c1 };
}

/** Ouvre une session interactive et répond au mot de passe. */
async function ouvrirSession(client: LinuxPC): Promise<TerminalSession> {
  const session = createSessionForDevice(client, 'T1')!;
  await flush();
  await type(session, `ssh alice@${SRV}`);
  if (session.currentInputMode.type === 'password') {
    session.setPasswordBuf(MDP);
    session.handleKey(key('Enter'));
    await flush();
  }
  return session;
}

describe('Phase 5 — la session ssh interactive vit sur le fil', () => {
  it('une commande tapée dans la session ouverte repart sur le câble', async () => {
    const { client, server, c1 } = await lab();
    const session = await ouvrirSession(client);

    // On est bien chez le distant, et pas resté chez soi. Le nom attendu
    // est celui que le serveur donne LUI-MÊME : le comparer à une
    // constante du test ne dirait rien de la machine.
    const nomDistant = (await server.executeCommand('hostname')).trim();
    const nomLocal = (await client.executeCommand('hostname')).trim();
    expect(nomDistant).not.toBe(nomLocal);

    await type(session, 'hostname');
    expect(linesOf(session).join('\n')).toContain(nomDistant);

    // La mesure : une commande de plus, et le câble doit bouger.
    const avant = frames(c1);
    await type(session, 'whoami');
    const apres = frames(c1);

    expect(linesOf(session).join('\n')).toContain('alice');
    expect(apres, 'la commande doit repartir sur le fil').toBeGreaterThan(avant);
  }, 60_000);

  it('la session est celle du distant, pas une session locale déguisée', async () => {
    const { client, server } = await lab();
    const session = await ouvrirSession(client);

    // Un fichier qui n'existe QUE sur le serveur : s'il est lisible, la
    // commande s'exécute bien là-bas. C'est plus probant qu'un `hostname`,
    // qu'un contournement bien fait saurait aussi imiter.
    await server.executeCommand(`sh -c 'echo "temoin-distant" > /tmp/preuve.txt'`);

    await type(session, 'cat /tmp/preuve.txt');
    expect(linesOf(session).join('\n')).toContain('temoin-distant');

    // Et le même chemin n'existe pas côté client.
    expect(await client.executeCommand('cat /tmp/preuve.txt'))
      .toContain('No such file or directory');
  }, 60_000);

  it('la session apparaît dans les sessions ouvertes du serveur', async () => {
    const { client, server } = await lab();
    await ouvrirSession(client);

    // `who` lit les sessions que le serveur a réellement acceptées : une
    // session qui n'aurait jamais traversé sa pile n'y figurerait pas.
    const who = await server.executeCommand('who');
    expect(who).toContain('alice');
  }, 60_000);
});
