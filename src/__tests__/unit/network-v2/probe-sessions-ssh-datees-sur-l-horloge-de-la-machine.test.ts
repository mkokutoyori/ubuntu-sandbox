/**
 * Apres `date -s`, une session SSH et tout ce qui la date doivent suivre l'horloge de la MACHINE. Mesure de depart, un
 * client et un serveur Linux dont on avance l'horloge de deux mois (`date -s`) avant une connexion :
 *  - `who` et `last` datent la session de l'heure globale du simulateur (SshSessionTable lisait `simulationDate()`) ;
 *  - `lastlog` et la banniere « Last login » aussi (LinuxLastlogRegistry.record) ;
 *  - `last` calcule « still logged in » / les durees sur l'heure globale (LinuxLastHost.nowSec, LinuxLastlogHost.nowSec) ;
 *  - la pile PAM entiere lisait l'heure globale (`LinuxPam.clock`) : `chage -E` posait une date d'expiration que
 *    `pam_unix` ne trouvait jamais depassee, donc un compte expire ouvrait toujours une session SSH et `su -` ;
 *  - CrossVendorSshHost.lifecycleGate (comptes expires des routeurs, switchs et postes) comparait l'echeance a l'heure globale.
 * Corrige : chaque lecteur prend l'horloge de sa machine (`simulatedDate()` / `getSystemClockMs()`).
 *
 * Discrimine par `git stash` sur src/network : 5 des 6 cas tombent avant. Le TEMOIN (connexion a l'heure, le compte non expire
 * ouvre une session) passe des deux cotes. Le gate de CrossVendorSshHost (routeurs, switchs, postes Windows) partage la
 * correction mais n'a pas de sonde propre ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const SSH = 'sshpass -p admin ssh -o StrictHostKeyChecking=no alice@10.0.0.2';

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  await srv.executeCommand('useradd -m -s /bin/bash alice');
  await srv.executeCommand("echo 'alice:admin' | chpasswd");
  return { pc, srv };
}

async function setClock(machine: LinuxPC | LinuxServer, wall: string): Promise<void> {
  await machine.executeCommand(`date -s "${wall}"`);
}

describe('une session SSH est datee sur l horloge de la machine', () => {
  it('TEMOIN — a l heure, le compte ouvre une session', async () => {
    const { pc } = await lab();
    expect((await pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
  }, 120_000);

  it('who date la session de la date posee par date -s', async () => {
    const { pc, srv } = await lab();
    await setClock(srv, '2027-03-15 09:30:00');
    await setClock(pc, '2027-03-15 09:30:00');
    expect(await pc.executeCommand(`${SSH} who`)).toContain('alice    pts/0        2027-03-15 09:30');
  }, 120_000);

  it('last date la session et la ferme a la date de la machine', async () => {
    const { pc, srv } = await lab();
    await setClock(srv, '2027-03-15 09:30:00');
    await setClock(pc, '2027-03-15 09:30:00');
    await pc.executeCommand(`${SSH} true`);
    await setClock(srv, '2027-03-15 11:45:00');
    expect(await srv.executeCommand('last -n 3')).toMatch(/alice\s+pts\/0\s+10\.0\.0\.1\s+Mon Mar 15 09:30 - 09:30\s+\(00:00\)/);
  }, 120_000);

  it('lastlog donne la date de la derniere connexion de la machine', async () => {
    const { pc, srv } = await lab();
    await setClock(srv, '2027-05-20 14:00:00');
    await setClock(pc, '2027-05-20 14:00:00');
    await pc.executeCommand(`${SSH} true`);
    expect(await srv.executeCommand('lastlog -u alice')).toContain('Thu May 20 14:00:00 +0000 2027');
  }, 120_000);

  it('un compte expire (chage -E) refuse su - avec le message de pam_unix', async () => {
    const { srv } = await lab();
    await setClock(srv, '2027-03-15 09:30:00');
    await srv.executeCommand('chage -E 2027-04-01 alice');
    expect((await srv.executeCommand('su - alice -c whoami')).trim()).toBe('alice');
    await setClock(srv, '2027-05-20 14:00:00');
    expect(await srv.executeCommand('su - alice -c whoami')).toContain('Your account has expired; please contact your system administrator.');
  }, 120_000);

  it('un compte expire refuse la session SSH', async () => {
    const { pc, srv } = await lab();
    await setClock(srv, '2027-03-15 09:30:00');
    await srv.executeCommand('chage -E 2027-04-01 alice');
    expect((await pc.executeCommand(`${SSH} whoami`)).trim()).toBe('alice');
    await setClock(srv, '2027-05-20 14:00:00');
    expect(await pc.executeCommand(`${SSH} whoami`)).toContain('Permission denied');
  }, 120_000);
});
