/**
 * Scénario 12 — Élévation de privilèges après connexion SSH (sudo)
 * et traçabilité.
 *
 * Objectif : vérifier que l'élévation de privilèges après une
 * connexion SSH standard est correctement journalisée et distincte
 * de l'authentification SSH elle-même. Le SOC doit pouvoir
 * répondre à deux questions distinctes :
 *   - « qui s'est connecté ? » → ligne `Accepted password for <u>`
 *   - « qui a élevé ses privilèges et pour faire quoi ? »
 *     → ligne `sudo: <u> : TTY=… ; PWD=… ; USER=root ; COMMAND=…`
 *
 * Avec horodatage cohérent entre les deux événements.
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

async function buildPair() {
  const pc  = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  const um = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  // alice est déjà dans le groupe `sudo` (le LinuxServer pré-provisionne
  // la cast alice/bob/carl/dave dans sudo). On lui repose le mot de
  // passe pour rester explicite.
  um.setPassword('alice', 'admin');
  // mallory est un nouveau compte créé sans groupe sudo — il déclenchera
  // le "not in sudoers".
  um.useradd('mallory', { m: true, s: '/bin/bash' });
  um.setPassword('mallory', 'admin');
  // rsyslog doit tourner pour que sudo écrive dans auth.log.
  await srv.executeCommand('systemctl start rsyslog');
  return { pc, srv };
}

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    readFile(p: string): string | null;
    resolveInode(p: string): { permissions: number; uid: number } | null;
  } } }).executor.vfs;
}

describe('Scénario 12 — SSH puis sudo : traçabilité complète', () => {
  it('/etc/sudoers existe avec la règle group "%sudo ALL=(ALL:ALL) ALL"', async () => {
    const { srv } = await buildPair();
    const sudoers = srvVfs(srv).readFile('/etc/sudoers') ?? '';
    expect(sudoers).toMatch(/^%sudo ALL=\(ALL:ALL\) ALL$/m);
    const inode = srvVfs(srv).resolveInode('/etc/sudoers');
    expect(inode).not.toBeNull();
    expect(inode!.uid).toBe(0);
    // 0440 = readonly à root + group (la convention sudo).
    expect(inode!.permissions & 0o777).toBe(0o440);
  });

  it('SSH alice puis sudo whoami : deux lignes distinctes dans auth.log', async () => {
    const { pc, srv } = await buildPair();
    const out = await pc.executeCommand('ssh alice@10.0.0.10 sudo whoami');
    expect(out).toMatch(/^root\s*$/m);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for alice from 10\.0\.0\.1/);
    expect(log).toMatch(/sudo: alice : TTY=pts\/0 ; PWD=\/home\/alice ; USER=root ; COMMAND=\/usr\/bin\/whoami/);
  });

  it('les deux événements (Accepted + sudo) sont distincts dans le journal', async () => {
    const { pc, srv } = await buildPair();
    await pc.executeCommand('ssh alice@10.0.0.10 sudo cat /etc/shadow');

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    const acceptedLines = log.split('\n').filter(l => /Accepted password for alice/.test(l));
    const sudoLines     = log.split('\n').filter(l => /^.*sudo: alice :/.test(l));
    expect(acceptedLines.length).toBeGreaterThanOrEqual(1);
    expect(sudoLines.length).toBeGreaterThanOrEqual(1);
  });

  it('mallory (NOT in sudo group) : "not in the sudoers file" + ligne d\'échec dans auth.log', async () => {
    const { pc, srv } = await buildPair();
    const out = await pc.executeCommand('ssh mallory@10.0.0.10 sudo cat /etc/shadow');
    expect(out).toMatch(/is not in the sudoers file/);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for mallory from 10\.0\.0\.1/);
    expect(log).toMatch(/sudo: mallory : user NOT in sudoers ; TTY=pts\/0 ; PWD=\/home\/mallory ; USER=root ; COMMAND=\/usr\/bin\/cat \/etc\/shadow/);
  });

  it('horodatage cohérent : la ligne sudo arrive APRÈS la ligne Accepted', async () => {
    const { pc, srv } = await buildPair();
    await pc.executeCommand('ssh alice@10.0.0.10 sudo id');

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    const lines = log.split('\n');
    const acceptedIdx = lines.findIndex(l => /Accepted password for alice/.test(l));
    const sudoIdx     = lines.findIndex(l => /sudo: alice :/.test(l));
    expect(acceptedIdx).toBeGreaterThanOrEqual(0);
    expect(sudoIdx).toBeGreaterThan(acceptedIdx);
  });

  it('sudo -S avec mauvais mot de passe : trace "1 incorrect password attempt"', async () => {
    const { pc, srv } = await buildPair();
    // SSH d'abord (capture l'Accepted), puis sudo -S avec WRONG.
    const out = await pc.executeCommand(
      'ssh alice@10.0.0.10 "echo WRONG | sudo -S whoami"',
    );
    expect(out).toMatch(/incorrect password/);

    const log = srvVfs(srv).readFile('/var/log/auth.log') ?? '';
    expect(log).toMatch(/Accepted password for alice/);
    expect(log).toMatch(/sudo: pam_unix\(sudo:auth\): authentication failure/);
    expect(log).toMatch(/sudo:  alice : 1 incorrect password attempt/);
  });
});
