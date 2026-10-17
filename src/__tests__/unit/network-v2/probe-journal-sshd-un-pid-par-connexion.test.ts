/*
 * Les lignes `sshd[<pid>]` du journal portent le PID du processus qui SERT
 * la connexion, pas celui de l'ecouteur.
 *
 * L'AUTORITE : OpenSSH 8.9p1, `sshd.c` : le demon qui ecoute fait un
 * `fork` par connexion acceptee ; tout ce qui concerne cette connexion
 * (« Connection from », « Accepted … », « Failed password », « Invalid
 * user », les lignes `pam_unix(sshd:session)`, « Disconnected from user »)
 * est ecrit par ce processus fils, sous SON pid, et `ps` le montre
 * `sshd: [accepted]` avant l'authentification puis `sshd: <user> [priv]`.
 * Deux connexions simultanees ont deux pids distincts, differents de
 * celui de l'ecouteur.
 *
 * Mesure de depart : quatre clients, `sshd[<pid de l'ecouteur>]` partout,
 * alors que la table des processus porte bien un `sshd: <user> [priv]`
 * par session.
 *
 * Ecrite contre ces sources, avant l'implantation. 3 des 5 cas tombent
 * avant. Passent des deux cotes le TEMOIN (le processus ecouteur existe) et
 * le nettoyage des processus de connexion (ils n'existaient pas).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
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
  const server = new LinuxServer('linux-server', 'SRV');
  const clientA = new LinuxPC('linux-pc', 'A', 0, 0);
  const clientB = new LinuxPC('linux-pc', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW');
  const mask = new SubnetMask('255.255.255.0');
  [server, clientA, clientB].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0] as never, sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(`10.99.0.${10 + index * 10}`), mask);
    device.powerOn();
  });
  await server.executeCommand('useradd -m -s /bin/bash bob');
  await server.executeCommand('echo bob:secret | chpasswd');
  return { server, clientA, clientB };
}

const SSH = (ip: string, command: string) =>
  `sshpass -p secret ssh -o StrictHostKeyChecking=no bob@${ip} ${command}`;

const pidsOf = (log: string, pattern: RegExp): string[] =>
  [...log.matchAll(pattern)].map((match) => match[1]);

describe('un pid par connexion', () => {
  it('TEMOIN: l\'ecouteur est un processus de la table', async () => {
    const { server } = await lab();
    expect(await server.executeCommand('ps -eo pid,args | grep "sshd -D"')).toMatch(/\d+ \/usr\/sbin\/sshd -D/);
  }, 120_000);

  it('les lignes d\'une connexion partagent un pid qui n\'est pas celui de l\'ecouteur', async () => {
    const { server, clientA } = await lab();
    const listener = /^\s*(\d+) \/usr\/sbin\/sshd -D/m.exec(await server.executeCommand('ps -eo pid,args'))![1];
    await clientA.executeCommand(SSH('10.99.0.10', 'true'));
    const log = await server.executeCommand('cat /var/log/auth.log');
    const accepted = pidsOf(log, /sshd\[(\d+)\]: Accepted password for bob/g);
    const closed = pidsOf(log, /sshd\[(\d+)\]: Disconnected from user bob/g);
    expect(accepted).toHaveLength(1);
    expect(closed).toEqual(accepted);
    expect(accepted[0]).not.toBe(listener);
  }, 120_000);

  it('deux connexions ont deux pids', async () => {
    const { server, clientA, clientB } = await lab();
    await clientA.executeCommand(SSH('10.99.0.10', 'true'));
    await clientB.executeCommand(SSH('10.99.0.10', 'true'));
    const log = await server.executeCommand('cat /var/log/auth.log');
    const accepted = pidsOf(log, /sshd\[(\d+)\]: Accepted password for bob/g);
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted).size).toBe(2);
  }, 120_000);

  it('un refus porte aussi le pid de sa connexion, jusqu\'a la deconnexion', async () => {
    const { server, clientA } = await lab();
    await clientA.executeCommand('sshpass -p wrong ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no bob@10.99.0.10 true');
    const log = await server.executeCommand('cat /var/log/auth.log');
    const failed = pidsOf(log, /sshd\[(\d+)\]: Failed password for bob/g);
    expect(failed.length).toBeGreaterThan(0);
    const listener = /^\s*(\d+) \/usr\/sbin\/sshd -D/m.exec(await server.executeCommand('ps -eo pid,args'))![1];
    expect(failed[0]).not.toBe(listener);
  }, 120_000);

  it('les processus de connexion disparaissent avec la connexion', async () => {
    const { server, clientA } = await lab();
    await clientA.executeCommand(SSH('10.99.0.10', 'true'));
    const processes = await server.executeCommand('ps -eo pid,args');
    expect(processes).not.toContain('sshd: [accepted]');
    expect(processes).not.toContain('sshd: bob [priv]');
  }, 120_000);
});
