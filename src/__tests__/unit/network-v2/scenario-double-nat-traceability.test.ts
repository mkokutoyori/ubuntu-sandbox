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
  in1: LinuxPC;
  in2: LinuxPC;
  in3: LinuxPC;
  nat1: CiscoRouter;
  nat2: CiscoRouter;
  outside: LinuxServer;
}

const IN1_IP = '192.168.10.10';
const IN2_IP = '192.168.10.20';
const IN3_IP = '192.168.10.30';
const NAT1_INSIDE = '192.168.10.1';
const NAT1_DMZ = '172.16.0.2';
const NAT2_DMZ = '172.16.0.1';
const NAT2_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.10';

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch', 'lan', 8, 0, 0);
  const dmzSw = new GenericSwitch('switch', 'dmz', 8, 0, 0);
  const wanSw = new GenericSwitch('switch', 'wan', 8, 0, 0);
  const nat1 = new CiscoRouter('nat1', 0, 0);
  const nat2 = new CiscoRouter('nat2', 0, 0);
  const in1 = new LinuxPC('linux-pc', 'in1', 0, 0);
  const in2 = new LinuxPC('linux-pc', 'in2', 0, 0);
  const in3 = new LinuxPC('linux-pc', 'in3', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(in1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(in2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(in3.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], nat1.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(nat1.getPort('GigabitEthernet0/1')!, dmzSw.getPorts()[0]);
  new Cable('f').connect(dmzSw.getPorts()[7], nat2.getPort('GigabitEthernet0/0')!);
  new Cable('g').connect(nat2.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('h').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m24 = new SubnetMask('255.255.255.0');
  in1.getPorts()[0].configureIP(new IPAddress(IN1_IP), m24);
  in2.getPorts()[0].configureIP(new IPAddress(IN2_IP), m24);
  in3.getPorts()[0].configureIP(new IPAddress(IN3_IP), m24);
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), m24);
  in1.setDefaultGateway(new IPAddress(NAT1_INSIDE));
  in2.setDefaultGateway(new IPAddress(NAT1_INSIDE));
  in3.setDefaultGateway(new IPAddress(NAT1_INSIDE));
  outside.setDefaultGateway(new IPAddress(NAT2_OUTSIDE));

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${NAT1_INSIDE} 255.255.255.0`, 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${NAT1_DMZ} 255.255.255.0`, 'ip nat outside', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1',
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    'end',
  ]) await nat1.executeCommand(cmd);

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${NAT2_DMZ} 255.255.255.0`, 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    `ip address ${NAT2_OUTSIDE} 255.255.255.0`, 'ip nat outside', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1',
    'access-list 1 permit 172.16.0.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    'end',
  ]) await nat2.executeCommand(cmd);

  return { in1, in2, in3, nat1, nat2, outside };
}

interface Xlate {
  proto: string;
  igIp: string; igPort: number;
  ilIp: string; ilPort: number;
  olIp: string; olPort: number;
  ogIp: string; ogPort: number;
}
function parseNatTable(raw: string): Xlate[] {
  const rx = /^(tcp|udp|icmp)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/i;
  return raw.split('\n').map(l => l.trim()).map(l => rx.exec(l)).filter(Boolean).map(m => ({
    proto: m![1].toLowerCase(),
    igIp: m![2], igPort: Number(m![3]),
    ilIp: m![4], ilPort: Number(m![5]),
    olIp: m![6], olPort: Number(m![7]),
    ogIp: m![8], ogPort: Number(m![9]),
  } as Xlate));
}

describe('Scénario 15 — Double NAT: traçabilité port interne → DMZ → externe', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('un ping à travers la chaîne double-NAT établit une entrée sur chaque niveau', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
    const t1 = await lab.nat1.executeCommand('show ip nat translations');
    const t2 = await lab.nat2.executeCommand('show ip nat translations');
    expect(t1).toMatch(new RegExp(IN1_IP.replace(/\./g, '\\.')));
    expect(t1).toMatch(new RegExp(NAT1_DMZ.replace(/\./g, '\\.')));
    expect(t2).toMatch(new RegExp(NAT1_DMZ.replace(/\./g, '\\.')));
    expect(t2).toMatch(new RegExp(NAT2_OUTSIDE.replace(/\./g, '\\.')));
  });

  it('3 sessions TCP simultanées: chaque niveau attribue un port distinct par session', async () => {
    const lab = await buildLab();
    await Promise.all([
      lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in3.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
    ]);
    const nat1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const nat2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    expect(nat1.length).toBeGreaterThanOrEqual(3);
    expect(nat2.length).toBeGreaterThanOrEqual(3);
    const nat1DmzPorts = nat1.map(e => e.igPort);
    const nat2WanPorts = nat2.map(e => e.igPort);
    expect(new Set(nat1DmzPorts).size).toBe(nat1DmzPorts.length);
    expect(new Set(nat2WanPorts).size).toBe(nat2WanPorts.length);
    for (const e of nat1) expect(e.igIp).toBe(NAT1_DMZ);
    for (const e of nat2) expect(e.igIp).toBe(NAT2_OUTSIDE);
  });

  it('la corrélation NAT1 ↔ NAT2 par port DMZ permet la reconstitution complète chaîne interne→externe', async () => {
    const lab = await buildLab();
    await Promise.all([
      lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in3.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
    ]);
    const nat1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const nat2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const chains: Array<{ internalIp: string; internalPort: number; dmzPort: number; wanPort: number }> = [];
    for (const e1 of nat1) {
      const dmzPort = e1.igPort;
      const e2 = nat2.find(x => x.ilIp === NAT1_DMZ && x.ilPort === dmzPort);
      if (e2) chains.push({ internalIp: e1.ilIp, internalPort: e1.ilPort, dmzPort, wanPort: e2.igPort });
    }
    expect(chains.length).toBeGreaterThanOrEqual(3);
    expect(new Set(chains.map(c => c.internalIp)).size).toBe(chains.length);
    expect(new Set(chains.map(c => c.wanPort)).size).toBe(chains.length);
  });

  it('les ports externes finaux sont uniques même si deux machines internes utilisent le même port source', async () => {
    const lab = await buildLab();
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
        lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      ]);
    }
    const nat2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const wanPorts = nat2.map(e => `${e.igIp}:${e.igPort}`);
    expect(new Set(wanPorts).size).toBe(wanPorts.length);
  });

  it('chaque paquet à travers la chaîne conserve la cohérence (source IP réécrite deux fois, port source deux fois)', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    const nat1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const nat2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ogPort === 22);
    const e1 = nat1.find(e => e.ilIp === IN1_IP);
    expect(e1).toBeDefined();
    expect(e1!.igIp).toBe(NAT1_DMZ);
    const e2 = nat2.find(e => e.ilIp === NAT1_DMZ && e.ilPort === e1!.igPort);
    expect(e2).toBeDefined();
    expect(e2!.igIp).toBe(NAT2_OUTSIDE);
    expect(e1!.olIp).toBe(OUTSIDE_IP);
    expect(e1!.ogIp).toBe(OUTSIDE_IP);
    expect(e2!.olIp).toBe(OUTSIDE_IP);
    expect(e2!.ogIp).toBe(OUTSIDE_IP);
    expect(e2!.ogPort).toBe(22);
  });

  it('clear ip nat translation * sur NAT2 laisse la table de NAT1 intacte, pas d\'état résiduel incohérent', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    const before1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations')).length;
    const before2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations')).length;
    expect(before1).toBeGreaterThan(0);
    expect(before2).toBeGreaterThan(0);
    await lab.nat2.executeCommand('clear ip nat translation *');
    const after2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations')).length;
    expect(after2).toBe(0);
    const after1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations')).length;
    expect(after1).toBe(before1);
  });

  it('après clear complet des deux niveaux, une nouvelle session recrée bien une entrée à chaque niveau', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    await lab.nat1.executeCommand('clear ip nat translation *');
    await lab.nat2.executeCommand('clear ip nat translation *');
    const empty1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations')).length;
    const empty2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations')).length;
    expect(empty1).toBe(0);
    expect(empty2).toBe(0);
    await lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    const t1 = parseNatTable(await lab.nat1.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ilIp === IN2_IP);
    const t2 = parseNatTable(await lab.nat2.executeCommand('show ip nat translations'))
      .filter(e => e.proto === 'tcp' && e.ilIp === NAT1_DMZ);
    expect(t1.length).toBeGreaterThan(0);
    expect(t2.length).toBeGreaterThan(0);
  });
});
