/**
 * Mesure de depart : `sftp -b lot.txt bob@10.93.0.20` depuis un WindowsPC faisait franchir ZERO
 * trame au cable (`Cable.getStats().framesTransmitted`), un lot `bye` comme un `get` de 200001
 * octets, et le fichier arrivait pourtant. `runWindowsSshClient` retrouvait la machine distante
 * par `findHostByAddress` et `resolveRemoteSftpFs` lisait son systeme de fichiers en memoire : la
 * regle 4 violee de bout en bout, sans mot de passe demande. Le client Windows ouvre maintenant
 * une vraie session SSH (`openWireSshConnection`, comme `ssh` et `scp`) puis un canal SFTP, et
 * chaque lecture est un paquet SSH_FXP sur le cable ; le compte nomme est celui du serveur.
 *
 * Mesure par DIFFERENCE, parce qu'une connexion reelle precede toujours une commande irreelle : le
 * meme echange avec et sans le fichier de 200001 octets. Quatre cas, trois tombent avant la
 * correction (trames de la connexion, trames de la charge utile, refus d'un mauvais mot de
 * passe) ; le TEMOIN passe dans les deux etats : le fichier arrive intact, ce qui prouve que le
 * laboratoire transfere et que le compteur de trames n'est pas simplement muet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab() {
  const win = new WindowsPC('windows-pc', 'WIN');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  const winCable = new Cable('c1');
  winCable.connect(win.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.93.0.10'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.93.0.20'), mask);
  win.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash bob');
  await server.executeCommand(`sh -c 'echo "bob:secret" | chpasswd'`);
  await server.executeCommand(`sh -c 'head -c 200000 /dev/zero | tr "\\0" A > /home/bob/big.txt'`);
  await server.executeCommand('chown bob:bob /home/bob/big.txt');
  return { win, winCable };
}

async function framesOf(
  win: WindowsPC, winCable: Cable, verb: string, password: string,
): Promise<{ frames: number; output: string }> {
  await win.executeCommand(`echo ${verb} > C:\\lot.txt`);
  const before = winCable.getStats().framesTransmitted;
  const output = await win.executeCommand('sftp -b C:\\lot.txt bob@10.93.0.20', password);
  return { frames: winCable.getStats().framesTransmitted - before, output };
}

describe('sftp from a Windows host crosses the cable', () => {
  it('witness: the 200001-byte file arrives intact', async () => {
    const { win, winCable } = await lab();
    await framesOf(win, winCable, 'get /home/bob/big.txt C:\\\\big.txt', 'secret');
    expect((await win.executeCommand('dir C:\\big.txt'))).toContain('200,001');
  }, 60_000);

  it('an sftp session costs frames', async () => {
    const { win, winCable } = await lab();
    expect((await framesOf(win, winCable, 'bye', 'secret')).frames).toBeGreaterThan(10);
  }, 60_000);

  it('the same session fetching 200001 bytes costs more frames than one that fetches nothing', async () => {
    const { win, winCable } = await lab();
    const empty = await framesOf(win, winCable, 'bye', 'secret');
    const loaded = await framesOf(win, winCable, 'get /home/bob/big.txt C:\\\\big.txt', 'secret');
    expect(loaded.frames).toBeGreaterThan(empty.frames + 20);
  }, 60_000);

  it('a wrong password is refused by the server', async () => {
    const { win, winCable } = await lab();
    const refused = await framesOf(win, winCable, 'bye', 'not-the-password');
    expect(refused.output).toContain('Permission denied');
    expect(refused.output).not.toContain('Connected to');
  }, 60_000);
});
