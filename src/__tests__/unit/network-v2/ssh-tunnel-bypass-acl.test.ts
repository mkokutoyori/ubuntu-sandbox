/**
 * Scénario 14 — Tunnel SSH (port forwarding) et détournement de
 * règles de filtrage réseau.
 *
 * Objectif : démontrer qu'un tunnel SSH peut contourner des règles
 * d'ACL si `AllowTcpForwarding` n'est pas explicitement désactivé,
 * puis valider qu'après durcissement (AllowTcpForwarding no), la
 * neutralisation est effective.
 *
 * Topologie :
 *   publicPC  10.0.10.10/24 ─┐
 *                            ├─ CiscoRouter G0/0 (ACL inbound 100)
 *                            │  ─ G0/1 ─ switch ─ jump 10.0.30.10
 *                            │                  └─ backend 10.0.30.20
 *
 * ACL 100 sur G0/0 inbound :
 *   deny  tcp host 10.0.10.10 host 10.0.30.20 eq 3306
 *   permit ip any any
 *
 * Phase 1 (vulnérable) : `ssh -fNL 13306:10.0.30.20:3306 alice@jump`
 *   ouvre un listener local 127.0.0.1:13306. Un `nc -zv 127.0.0.1
 *   13306` réussit car la connexion de sortie part de `jump` (même
 *   sous-réseau que le backend), bypassant l'ACL qui ne filtre que
 *   `publicPC → backend`.
 *
 * Phase 2 (durcie) : on ajoute `AllowTcpForwarding no` à
 *   /etc/ssh/sshd_config de jump et on `systemctl reload ssh`. Le
 *   même `ssh -fNL` reçoit `administratively prohibited`, aucun
 *   listener n'apparaît, et `nc 127.0.0.1 13306` tombe en échec.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

async function buildLan() {
  const publicPc = new LinuxPC('linux-pc', 'public-pc', 0, 0);
  const router   = new CiscoRouter('switch-l3');
  const sw       = new GenericSwitch('switch-generic', 'sw-internal');
  const jump     = new LinuxServer('linux-server', 'jump', 0, 0);
  const backend  = new LinuxServer('linux-server', 'backend', 0, 0);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.10.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.30.1'), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(publicPc.getPorts()[0], router.getPorts()[0]);
  new Cable('c2').connect(router.getPorts()[1],   sw.getPorts()[0]);
  new Cable('c3').connect(sw.getPorts()[1],       jump.getPorts()[0]);
  new Cable('c4').connect(sw.getPorts()[2],       backend.getPorts()[0]);

  publicPc.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
  jump.getPorts()[0].configureIP(new IPAddress('10.0.30.10'),     new SubnetMask('255.255.255.0'));
  backend.getPorts()[0].configureIP(new IPAddress('10.0.30.20'),  new SubnetMask('255.255.255.0'));

  publicPc.setDefaultGateway(new IPAddress('10.0.10.1'));
  jump.setDefaultGateway(new IPAddress('10.0.30.1'));
  backend.setDefaultGateway(new IPAddress('10.0.30.1'));

  for (const srv of [jump, backend]) {
    const um = (srv as unknown as { executor: { userMgr: {
      useradd(u: string, o?: object): void;
      setPassword(u: string, p: string): void;
    } } }).executor.userMgr;
    um.useradd('alice', { m: true, s: '/bin/bash' });
    um.setPassword('alice', 'admin');
  }
  await backend.executeCommand('systemctl start mysql');
  // systemctl projects mysqld into /proc/net/tcp but does not open a real
  // TCP accept-loop; bind one explicitly so the TCP stack answers SYNs
  // — this is the mysqld daemon that listens for clients.
  (backend as unknown as { getTcpStack(): { listen(p: number, h: object): void } })
    .getTcpStack().listen(3306, { onAccept: () => { /* hold open */ } });

  return { publicPc, router, jump, backend };
}

async function installFilteringAcl(router: CiscoRouter) {
  for (const cmd of [
    'enable',
    'configure terminal',
    'access-list 100 deny tcp host 10.0.10.10 host 10.0.30.20 eq 3306',
    'access-list 100 permit ip any any',
    'interface GigabitEthernet0/0',
    'ip access-group 100 in',
    'end',
  ]) await router.executeCommand(cmd);
}

function srvVfs(srv: LinuxServer) {
  return (srv as unknown as { executor: { vfs: {
    readFile(p: string): string | null;
    writeFile(p: string, c: string, uid: number, gid: number, umask: number): void;
  } } }).executor.vfs;
}

describe('Scénario 14 — Tunnel SSH et contournement d\'ACL', () => {
  // ── Pré-conditions : le backend est bien joignable depuis jump
  // (même sous-réseau, aucune ACL) mais l'ACL bloque le chemin
  // direct depuis publicPC.
  it('le backend écoute bien sur 3306', async () => {
    const { backend } = await buildLan();
    const ss = await backend.executeCommand('ss -tln');
    expect(ss).toMatch(/:3306/);
  });

  it('show access-lists 100 montre la règle bloquante', async () => {
    const { router } = await buildLan();
    await installFilteringAcl(router);
    const out = await router.executeCommand('show access-lists 100');
    expect(out).toMatch(/deny tcp host 10\.0\.10\.10 host 10\.0\.30\.20 eq 3306/);
    expect(out).toMatch(/permit ip any any/);
  });

  it('accès direct publicPC → backend:3306 : Connection timed out (ACL drop)', async () => {
    const { publicPc, router } = await buildLan();
    await installFilteringAcl(router);
    const out = await publicPc.executeCommand('nc -zv 10.0.30.20 3306');
    expect(out).not.toMatch(/succeeded/);
  });

  it('depuis jump, l\'accès au backend:3306 reste fonctionnel (même sous-réseau)', async () => {
    const { jump, router } = await buildLan();
    await installFilteringAcl(router);
    const out = await jump.executeCommand('nc -zv 10.0.30.20 3306');
    expect(out).toMatch(/succeeded/);
  });

  // ── Phase 1 : tunnel SSH non restreint → contournement réussi.

  it('SSH publicPC → jump:22 est autorisé (canal du tunnel)', async () => {
    const { publicPc, router } = await buildLan();
    await installFilteringAcl(router);
    const out = await publicPc.executeCommand('ssh alice@10.0.30.10 echo ok');
    expect(out).toMatch(/^ok\s*$/m);
  });

  it('ssh -fNL 13306:backend:3306 alice@jump : listener local apparaît dans ss -tln', async () => {
    const { publicPc, router } = await buildLan();
    await installFilteringAcl(router);
    const out = await publicPc.executeCommand(
      'ssh -fNL 13306:10.0.30.20:3306 alice@10.0.30.10',
    );
    expect(out).not.toMatch(/administratively prohibited/);
    const ss = await publicPc.executeCommand('ss -tln');
    expect(ss).toMatch(/127\.0\.0\.1:13306/);
  });

  it('nc -zv 127.0.0.1 13306 via tunnel : contournement réussi', async () => {
    const { publicPc, router } = await buildLan();
    await installFilteringAcl(router);
    await publicPc.executeCommand('ssh -fNL 13306:10.0.30.20:3306 alice@10.0.30.10');
    const out = await publicPc.executeCommand('nc -zv 127.0.0.1 13306');
    expect(out).toMatch(/succeeded/);
  });

  // ── Phase 2 : durcissement (AllowTcpForwarding no) → tunnel refusé.

  it('AllowTcpForwarding no + reload : ssh -fNL est refusé (administratively prohibited)', async () => {
    const { publicPc, router, jump } = await buildLan();
    await installFilteringAcl(router);

    const sshd = srvVfs(jump).readFile('/etc/ssh/sshd_config') ?? '';
    srvVfs(jump).writeFile(
      '/etc/ssh/sshd_config',
      sshd + '\nAllowTcpForwarding no\n',
      0, 0, 0o022,
    );
    await jump.executeCommand('systemctl reload ssh');

    const out = await publicPc.executeCommand(
      'ssh -fNL 13306:10.0.30.20:3306 alice@10.0.30.10',
    );
    expect(out).toMatch(/administratively prohibited/i);
  });

  it('après durcissement : aucun listener ss -tln ne se présente sur 13306', async () => {
    const { publicPc, router, jump } = await buildLan();
    await installFilteringAcl(router);

    const sshd = srvVfs(jump).readFile('/etc/ssh/sshd_config') ?? '';
    srvVfs(jump).writeFile(
      '/etc/ssh/sshd_config',
      sshd + '\nAllowTcpForwarding no\n',
      0, 0, 0o022,
    );
    await jump.executeCommand('systemctl reload ssh');

    await publicPc.executeCommand('ssh -fNL 13306:10.0.30.20:3306 alice@10.0.30.10');
    const ss = await publicPc.executeCommand('ss -tln');
    expect(ss).not.toMatch(/127\.0\.0\.1:13306/);
  });

  it('après durcissement : nc -zv 127.0.0.1 13306 échoue (pas de tunnel)', async () => {
    const { publicPc, router, jump } = await buildLan();
    await installFilteringAcl(router);

    const sshd = srvVfs(jump).readFile('/etc/ssh/sshd_config') ?? '';
    srvVfs(jump).writeFile(
      '/etc/ssh/sshd_config',
      sshd + '\nAllowTcpForwarding no\n',
      0, 0, 0o022,
    );
    await jump.executeCommand('systemctl reload ssh');

    await publicPc.executeCommand('ssh -fNL 13306:10.0.30.20:3306 alice@10.0.30.10');
    const out = await publicPc.executeCommand('nc -zv 127.0.0.1 13306');
    expect(out).not.toMatch(/succeeded/);
  });
});
