/*
 * Un editeur tape dans un saut ssh imbrique s'ouvre sur le saut, pas sur
 * l'hote intermediaire.
 *
 * L'AUTORITE est OpenSSH (clientloop.c, session.c) : le client `ssh` de
 * l'hote intermediaire A ne connait aucun editeur, il relaie les octets de
 * son pty vers le canal de B ; `vim` tourne sur B, avec le fichier de B.
 * Ici le protocole d'editeur est structure (editor_open / editor_key /
 * editor_view) au lieu d'un flux d'octets : A relaie donc chaque message
 * vers le canal de B et renvoie l'ecran que B produit, dans l'ordre.
 *
 * Mesure de depart, `vim /tmp/saut.txt` demande sur le canal de A apres
 * `ssh user@B` : A ouvrait son PROPRE editeur, le fichier etait cree sur A
 * et jamais sur B.
 *
 * Discriminee par `git stash push -- src/network src/terminal src/shell` :
 * avant, 2 des 4 cas tombent (l'ecran vient de B ; les frappes et
 * l'enregistrement atteignent B). Les 2 autres passent des deux cotes et
 * sont des TEMOINS : l'editeur local de A sans saut, et le shell du saut
 * qui repond apres la sortie de l'editeur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { noopSshLocalFs } from './_helpers/noopSshLocalFs';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ channel: ISshShellChannel; hostA: LinuxPC; hostB: LinuxPC }> {
  const operator = new LinuxPC('linux-pc', 'operator');
  const hostA = new LinuxPC('linux-pc', 'hostA');
  const hostB = new LinuxPC('linux-pc', 'hostB');
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [operator, hostA, hostB].forEach((pc, i) => {
    new Cable(`c${i}`).connect(pc.getPorts()[0], sw.getPorts()[i]);
    pc.getPorts()[0].configureIP(new IPAddress(`10.0.0.${i + 1}`), MASK);
  });
  for (const pc of [hostA, hostB]) {
    const userMgr = (pc as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void;
    } } }).executor.userMgr;
    userMgr.useradd('user', { m: true, s: '/bin/bash' });
    userMgr.setPassword('user', 'admin');
    await pc.executeCommand('sudo systemctl start ssh');
  }
  const dev = operator as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: noopSshLocalFs() as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const connected = await session.connect(
    SshConnectOptionsBuilder.create().host('10.0.0.2').user('user').password('admin')
      .strictHostKeyChecking('no').build());
  if (!isOk(connected)) throw new Error('connect to A failed');
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel on A failed');
  return { channel: channel.value, hostA, hostB };
}

describe('un editeur tape dans un saut imbrique s\'ouvre sur le saut', () => {
  it('l\'ecran renvoye est celui d\'un editeur ouvert sur B', async () => {
    const { channel, hostA, hostB } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    await hostB.executeCommand("sh -c 'echo contenu-de-B > /tmp/saut.txt'");
    const view = await channel.openEditor('vim /tmp/saut.txt') as unknown as { lines?: string[] } | null;
    expect(view?.lines?.join('\n')).toContain('contenu-de-B');
    expect(await hostA.executeCommand('cat /tmp/saut.txt')).not.toContain('contenu-de-B');
    channel.closeEditor();
  });

  it('TEMOIN : sans saut, l\'editeur est celui de A', async () => {
    const { channel, hostA } = await lab();
    await hostA.executeCommand("sh -c 'echo contenu-de-A > /tmp/local.txt'");
    const view = await channel.openEditor('vim /tmp/local.txt') as unknown as { lines?: string[] } | null;
    expect(view?.lines?.join('\n')).toContain('contenu-de-A');
    channel.closeEditor();
  });

  it('les frappes atteignent B : le fichier saisi puis enregistre existe sur B seulement', async () => {
    const { channel, hostA, hostB } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    await channel.openEditor('vim /tmp/saut.txt');
    for (const key of 'ibonjour') await channel.sendEditorKey({ key });
    await channel.sendEditorKey({ key: 'Escape' });
    for (const key of ':wq') await channel.sendEditorKey({ key });
    const last = await channel.sendEditorKey({ key: 'Enter' });
    expect(last?.exited).toBe(true);
    expect(await hostB.executeCommand('cat /tmp/saut.txt')).toContain('bonjour');
    expect(await hostA.executeCommand('cat /tmp/saut.txt')).not.toContain('bonjour');
  });

  it('apres la sortie de l\'editeur, le shell du saut repond', async () => {
    const { channel } = await lab();
    await channel.runLine('ssh -o StrictHostKeyChecking=no user@10.0.0.3');
    await channel.provideInput('admin');
    await channel.openEditor('vim /tmp/saut.txt');
    await channel.sendEditorKey({ key: 'Escape' });
    for (const key of ':q') await channel.sendEditorKey({ key });
    await channel.sendEditorKey({ key: 'Enter' });
    let seen = '';
    channel.onData((chunk) => { seen += chunk; });
    const result = await channel.runLine('hostname');
    expect(`${result.stdout}${seen}`).toContain('hostB');
  });
});
