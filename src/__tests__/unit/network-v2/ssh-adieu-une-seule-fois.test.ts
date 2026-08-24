/**
 * Une session SSH ne dit adieu QU'UNE FOIS.
 *
 * Transcription rapportee par l'utilisateur, depuis un serveur Linux
 * vers un poste Windows :
 *
 *   C:\\Users\\alice>exit
 *   Connection to 192.168.10.15 closed.
 *   root@Server1:~#
 *   logout
 *   Connection to 192.168.10.15 closed.      <- une seconde fois
 *
 * Le message de fermeture reparait alors que la session est deja close,
 * et une ligne d'invite s'invite dans le defilement.
 *
 * MESURE : les deux sorties DELIBEREES de `SshInteractiveSubShell`
 * (`exit`/`logout` tape, et fin decidee par le serveur) impriment leur
 * adieu et appellent `session.disconnect()` sans poser `closing`. Le
 * gestionnaire de fermeture du canal — dont l'objet est le raccrochage
 * IMPREVU, cable arrache ou machine eteinte — se declenche donc ensuite
 * et imprime le meme adieu une seconde fois. Le drapeau existait ; les
 * deux sorties normales ne le posaient pas.
 */

import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function taper(host: TerminalSession, texte: string, secret = 'alice') {
  host.foreground.setInput(texte);
  host.foreground.setInputBuf(texte);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(secret);
    host.handleKey(key('Enter'));
    for (let i = 0; i < 10; i++) await tick();
  }
}

function transcription(host: TerminalSession): string[] {
  return host.lines.map(l => (typeof l === 'string' ? l : l.text ?? ''));
}

function adieux(host: TerminalSession): number {
  return transcription(host).filter(l => l.includes('Connection to')).length;
}

function laboratoire(distant: 'windows' | 'linux') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const serveur = new LinuxServer('linux-server', 'Server1', 0, 0);
  const poste = distant === 'windows'
    ? new WindowsPC('windows-pc', 'WIN', 200, 0)
    : new LinuxPC('linux-pc', 'PC2', 200, 0);
  serveur.powerOn();
  poste.powerOn();
  new Cable('c1').connect(serveur.getPorts()[0], poste.getPorts()[0]);

  const mask = new SubnetMask('255.255.255.0');
  serveur.getPorts()[0].configureIP(new IPAddress('192.168.10.1'), mask);
  poste.getPorts()[0].configureIP(new IPAddress('192.168.10.15'), mask);

  return { serveur, poste };
}

describe('une session SSH ne dit adieu qu une fois', () => {
  it('la transcription rapportee : sortir de cmd puis taper `logout`', async () => {
    const { serveur } = laboratoire('windows');
    const host = new LinuxTerminalSession('h', serveur);
    await host.init?.();

    await taper(host, 'ssh alice@192.168.10.15');
    await taper(host, 'powershell');
    await taper(host, 'exit');
    await taper(host, 'exit');
    await taper(host, 'logout');

    expect(adieux(host)).toBe(1);
  });

  it('l adieu suit la forme d OpenSSH : `logout` puis la fermeture',
    async () => {
      const { serveur } = laboratoire('windows');
      const host = new LinuxTerminalSession('h', serveur);
      await host.init?.();

      await taper(host, 'ssh alice@192.168.10.15');
      await taper(host, 'exit');

      const lignes = transcription(host);
      const fermeture = lignes.findIndex(l => l.includes('Connection to'));
      expect(fermeture).toBeGreaterThan(0);
      expect(lignes[fermeture - 1]).toBe('logout');
    });

  it('aucune invite ne s invite dans le defilement apres la fermeture',
    async () => {
      const { serveur } = laboratoire('windows');
      const host = new LinuxTerminalSession('h', serveur);
      await host.init?.();

      await taper(host, 'ssh alice@192.168.10.15');
      await taper(host, 'exit');

      expect(transcription(host).filter(l => /^root@Server1:.*#\s*$/.test(l)))
        .toHaveLength(0);
    });

  it('vers un hote Linux non plus, l adieu ne se repete pas', async () => {
    const { serveur, poste } = laboratoire('linux');
    const gestionnaire = (poste as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void;
      getUser(u: string): unknown;
      setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    if (!gestionnaire.getUser('alice')) {
      gestionnaire.useradd('alice', { m: true, s: '/bin/bash' });
    }
    gestionnaire.setPassword('alice', 'alice');

    const host = new LinuxTerminalSession('h', serveur);
    await host.init?.();

    await taper(host, 'ssh alice@192.168.10.15');
    await taper(host, 'exit');
    await taper(host, 'logout');

    expect(adieux(host)).toBe(1);
  });
});
