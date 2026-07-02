import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  clientOk: LinuxPC;
  clientBlockedBySshd: LinuxPC;
  clientBlockedByFw: LinuxPC;
  clientBlockedByAcl: LinuxPC;
  server: LinuxServer;
  router: CiscoRouter;
  swA: GenericSwitch;
  swOther: GenericSwitch;
}

async function buildLab(): Promise<Lab> {
  const router = new CiscoRouter('router');
  const swA = new GenericSwitch('switch', 'sw-A', 8, 0, 0);
  const swOther = new GenericSwitch('switch', 'sw-Other', 8, 0, 0);
  const clientOk = new LinuxPC('linux-pc', 'client-ok', 0, 0);
  const clientBlockedBySshd = new LinuxPC('linux-pc', 'client-sshd', 0, 0);
  const clientBlockedByFw = new LinuxPC('linux-pc', 'client-fw', 0, 0);
  const clientBlockedByAcl = new LinuxPC('linux-pc', 'client-acl', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);

  router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.10.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.20.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/2', new IPAddress('10.0.30.1'), new SubnetMask('255.255.255.0'));

  new Cable('c1').connect(clientOk.getPorts()[0], swA.getPorts()[0]);
  new Cable('c2').connect(clientBlockedBySshd.getPorts()[0], swA.getPorts()[1]);
  new Cable('c3').connect(clientBlockedByFw.getPorts()[0], swA.getPorts()[2]);
  new Cable('c4').connect(swA.getPorts()[7], router.getPorts()[0]);
  new Cable('c5').connect(clientBlockedByAcl.getPorts()[0], swOther.getPorts()[0]);
  new Cable('c6').connect(swOther.getPorts()[7], router.getPorts()[1]);
  new Cable('c7').connect(server.getPorts()[0], router.getPorts()[2]);

  const m = new SubnetMask('255.255.255.0');
  clientOk.getPorts()[0].configureIP(new IPAddress('10.0.10.200'), m);
  clientBlockedBySshd.getPorts()[0].configureIP(new IPAddress('10.0.10.150'), m);
  clientBlockedByFw.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), m);
  clientBlockedByAcl.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.30.10'), m);
  clientOk.setDefaultGateway(new IPAddress('10.0.10.1'));
  clientBlockedBySshd.setDefaultGateway(new IPAddress('10.0.10.1'));
  clientBlockedByFw.setDefaultGateway(new IPAddress('10.0.10.1'));
  clientBlockedByAcl.setDefaultGateway(new IPAddress('10.0.20.1'));
  server.setDefaultGateway(new IPAddress('10.0.30.1'));

  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
    getUser(u: string): unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alice');

  return { clientOk, clientBlockedBySshd, clientBlockedByFw, clientBlockedByAcl, server, router, swA, swOther };
}

async function installRouterAcl(router: CiscoRouter): Promise<void> {
  for (const cmd of [
    'enable',
    'configure terminal',
    'access-list 100 permit tcp 10.0.10.0 0.0.0.255 host 10.0.30.10 eq 22',
    'access-list 100 deny tcp any host 10.0.30.10 eq 22',
    'access-list 100 permit ip any any',
    'interface GigabitEthernet0/2',
    'ip access-group 100 out',
    'end',
  ]) await router.executeCommand(cmd);
}

async function installHostFirewall(server: LinuxServer): Promise<void> {
  await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -s 10.0.10.128/25 -j ACCEPT');
  await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT');
}

async function installSshdWhitelist(server: LinuxServer): Promise<void> {
  await server.executeCommand(
    `sh -c 'printf "Match Address 10.0.10.128/26\\n  DenyUsers *\\nMatch Address 10.0.10.0/25\\n  DenyUsers *\\n" >> /etc/ssh/sshd_config'`,
  );
  await server.executeCommand('systemctl reload ssh');
}

async function provisionAll(lab: Lab): Promise<void> {
  await installRouterAcl(lab.router);
  await installHostFirewall(lab.server);
  await installSshdWhitelist(lab.server);
}

describe('Scénario 8 — Cohérence des ACL multi-niveaux sur le port 22', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('seul le client satisfaisant les 3 couches (10.0.10.200) obtient un shell', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    const out = await lab.clientOk.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Permission denied|Connection refused|Connection timed out/);
  });

  it('client hors subnet A (10.0.20.10) → bloqué par la couche ACL routeur (timed out)', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    const out = await lab.clientBlockedByAcl.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out).toMatch(/Connection timed out|No route to host/);
    expect(out).not.toMatch(/Connection refused/);
    expect(out).not.toMatch(/Permission denied/);
  });

  it('client dans A mais hors B (10.0.10.10) → bloqué par iptables REJECT (refused)', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    const out = await lab.clientBlockedByFw.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out).toMatch(/Connection refused/);
    expect(out).not.toMatch(/Connection timed out/);
    expect(out).not.toMatch(/Permission denied/);
  });

  it('client dans A ∩ B mais hors C (10.0.10.150) → bloqué par sshd Match Address (Permission denied)', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    const out = await lab.clientBlockedBySshd.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    expect(out).toMatch(/Permission denied/);
    expect(out).not.toMatch(/Connection refused/);
    expect(out).not.toMatch(/Connection timed out/);
  });

  it('compteurs Cisco ACL: deny incrémenté pour le client bloqué, permit pour les autres', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    await lab.clientBlockedByAcl.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientOk.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    const acl = await lab.router.executeCommand('show ip access-lists 100');
    const permit = /permit tcp 10\.0\.10\.0.*eq 22.*\((\d+) match/.exec(acl);
    const deny = /deny tcp any host 10\.0\.30\.10 eq 22.*\((\d+) match/.exec(acl);
    expect(permit).not.toBeNull();
    expect(deny).not.toBeNull();
    expect(parseInt(permit![1], 10)).toBeGreaterThan(0);
    expect(parseInt(deny![1], 10)).toBeGreaterThan(0);
  });

  it('compteurs iptables: REJECT incrémenté pour client hors B, pas de trace du client hors A', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    await lab.clientBlockedByAcl.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientBlockedByFw.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    const listing = await lab.server.executeCommand('iptables -L INPUT -n -v');
    const reject = /^\s*(\d+)\s+\d+\s+REJECT.*tcp.*dpt:22/m.exec(listing);
    expect(reject).not.toBeNull();
    expect(parseInt(reject![1], 10)).toBeGreaterThan(0);
  });

  it('auth.log sshd: le client bloqué par Match Address apparaît seul, pas le client bloqué par iptables', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    await lab.clientBlockedByAcl.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientBlockedByFw.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientBlockedBySshd.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    const log = await lab.server.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/10\.0\.10\.150/);
    expect(log).not.toMatch(/10\.0\.20\.10/);
    expect(log).not.toMatch(/10\.0\.10\.10\b/);
  });

  it('point de blocage unique et cohérent: chaque client bloqué laisse une trace à une seule couche', async () => {
    const lab = await buildLab();
    await provisionAll(lab);
    await lab.clientBlockedByAcl.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientBlockedByFw.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');
    await lab.clientBlockedBySshd.executeCommand('ssh alice@10.0.30.10 whoami', 'alice\n');

    const acl = await lab.router.executeCommand('show ip access-lists 100');
    const iptables = await lab.server.executeCommand('iptables -L INPUT -n -v');
    const auth = await lab.server.executeCommand('cat /var/log/auth.log');

    expect(acl).toMatch(/10\.0\.30\.10 eq 22.*\([1-9]\d* match/);
    expect(iptables).not.toMatch(/10\.0\.20\.10/);
    expect(auth).not.toMatch(/10\.0\.20\.10/);

    expect(auth).not.toMatch(/10\.0\.10\.10\b/);

    expect(auth).toMatch(/10\.0\.10\.150/);
    expect(acl).toMatch(/permit tcp 10\.0\.10\.0.*\([1-9]\d* match/);
  });
});
