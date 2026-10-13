/**
 * Mesure de depart : `ssh -i C:\cle alice@host cmd` depuis un WindowsPC ne lisait jamais la cle
 * nommee. Le chemin Windows (`C:\cle`) allait tel quel a la session filaire, dont le magasin
 * local parle POSIX (`WindowsSshLocalFs` traduit `/cle` en `C:\cle`, pas l'inverse) : la cle
 * restait introuvable, l'authentification filaire echouait, et `runWindowsSshClient` retombait sur
 * la « convention du simulateur » — la commande s'executait alors sur l'objet du serveur, SANS
 * traverser le cable. Mesure par DIFFERENCE de trames, le meme echange avec et sans fichier de
 * 200001 octets : 37 trames dans les deux cas avant la correction.
 *
 * `sshPathOfWindowsPath` (inverse de `toWindows`) convertit `C:\cle` en `/cle` avant la session
 * filaire, comme le fait deja `sftp`. Quatre cas : trois tombent avant la correction (trames de
 * la commande, trames de la charge utile, journal du serveur « Accepted publickey ») ; le TEMOIN
 * passe dans les deux etats : la commande rend le nom du serveur, donc le laboratoire, la cle et
 * `authorized_keys` sont sains et seule la route change.
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
  await server.executeCommand(`sh -c 'head -c 200000 /dev/zero | tr "\\0" A > /home/bob/big.txt'`);
  await server.executeCommand('chown bob:bob /home/bob/big.txt');
  await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\cle');
  const publique = (await win.executeCommand('type C:\\cle.pub')).trim();
  await server.executeCommand('mkdir -p /home/bob/.ssh');
  await server.executeCommand(`sh -c 'echo "${publique}" > /home/bob/.ssh/authorized_keys'`);
  await server.executeCommand('chown -R bob:bob /home/bob/.ssh');
  await server.executeCommand('chmod 700 /home/bob/.ssh');
  await server.executeCommand('chmod 600 /home/bob/.ssh/authorized_keys');
  return { win, server, winCable };
}

const SSH = 'ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=no -i C:\\cle bob@10.93.0.20';

async function framesOf(win: WindowsPC, winCable: Cable, remote: string) {
  const before = winCable.getStats().framesTransmitted;
  const output = await win.executeCommand(`${SSH} ${remote}`);
  return { frames: winCable.getStats().framesTransmitted - before, output };
}

describe('ssh from Windows offers the key named by -i over the cable', () => {
  it('witness: the command answers with the server name', async () => {
    const { win, server, winCable } = await lab();
    expect((await framesOf(win, winCable, 'hostname')).output.trim()).toBe(server.getHostname());
  }, 60_000);

  it('the server journal shows an accepted public key from the Windows host', async () => {
    const { win, server, winCable } = await lab();
    await framesOf(win, winCable, 'hostname');
    expect(await server.executeCommand('sudo tail -30 /var/log/auth.log'))
      .toMatch(/Accepted publickey for bob from 10\.93\.0\.10/);
  }, 60_000);

  it('a command costs frames', async () => {
    const { win, winCable } = await lab();
    expect((await framesOf(win, winCable, 'hostname')).frames).toBeGreaterThan(45);
  }, 60_000);

  it('fetching 200001 bytes costs more frames than a command that prints a name', async () => {
    const { win, winCable } = await lab();
    const small = await framesOf(win, winCable, 'hostname');
    const big = await framesOf(win, winCable, 'cat /home/bob/big.txt');
    expect(big.output.length).toBeGreaterThan(200_000);
    expect(big.frames).toBeGreaterThan(small.frames + 20);
  }, 60_000);
});
