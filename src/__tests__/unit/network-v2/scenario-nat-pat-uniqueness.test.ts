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
  gw: CiscoRouter;
  ispSw: GenericSwitch;
  lanSw: GenericSwitch;
  outside: LinuxServer;
}

const INSIDE_NET = '192.168.10.0/24';
const IN1_IP = '192.168.10.10';
const IN2_IP = '192.168.10.20';
const IN3_IP = '192.168.10.30';
const GW_INSIDE = '192.168.10.1';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.10';

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch', 'lan-sw', 8, 0, 0);
  const ispSw = new GenericSwitch('switch', 'isp-sw', 8, 0, 0);
  const gw = new CiscoRouter('gw', 0, 0);
  const in1 = new LinuxPC('linux-pc', 'in1', 0, 0);
  const in2 = new LinuxPC('linux-pc', 'in2', 0, 0);
  const in3 = new LinuxPC('linux-pc', 'in3', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);

  new Cable('a').connect(in1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(in2.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(in3.getPort('eth0')!, lanSw.getPorts()[2]);
  new Cable('d').connect(lanSw.getPorts()[7], gw.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(gw.getPort('GigabitEthernet0/1')!, ispSw.getPorts()[0]);
  new Cable('f').connect(ispSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  in1.getPorts()[0].configureIP(new IPAddress(IN1_IP), m);
  in2.getPorts()[0].configureIP(new IPAddress(IN2_IP), m);
  in3.getPorts()[0].configureIP(new IPAddress(IN3_IP), m);
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.0'));
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));
  in1.setDefaultGateway(new IPAddress(GW_INSIDE));
  in2.setDefaultGateway(new IPAddress(GW_INSIDE));
  in3.setDefaultGateway(new IPAddress(GW_INSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.0`,
    'ip nat outside',
    'no shutdown',
    'exit',
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    'end',
  ]) await gw.executeCommand(cmd);

  const um = (outside as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
    getUser(u: string): unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alice');

  return { in1, in2, in3, gw, ispSw, lanSw, outside };
}

interface Xlate {
  proto: string;
  insideGlobalIp: string;
  insideGlobalPort: number;
  insideLocalIp: string;
  insideLocalPort: number;
  outsideLocalIp: string;
  outsideLocalPort: number;
  outsideGlobalIp: string;
  outsideGlobalPort: number;
}

function parseNatTable(raw: string): Xlate[] {
  const lines = raw.split('\n').map(l => l.trim());
  const out: Xlate[] = [];
  const rx = /^(tcp|udp|icmp)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/i;
  for (const l of lines) {
    const m = rx.exec(l);
    if (!m) continue;
    out.push({
      proto: m[1].toLowerCase(),
      insideGlobalIp: m[2], insideGlobalPort: Number(m[3]),
      insideLocalIp:  m[4], insideLocalPort:  Number(m[5]),
      outsideLocalIp: m[6], outsideLocalPort: Number(m[7]),
      outsideGlobalIp:m[8], outsideGlobalPort:Number(m[9]),
    });
  }
  return out;
}

describe('Scénario 5 — Cohérence NAT/PAT: port externe unique par session interne', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('PAT est actif: chaque hôte interne ping traduit par le même globalIP mais différentes entrées', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
    await lab.in2.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
    await lab.in3.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
    const table = await lab.gw.executeCommand('show ip nat translations');
    expect(table).toMatch(new RegExp(`${IN1_IP.replace(/\./g, '\\.')}`));
    expect(table).toMatch(new RegExp(`${IN2_IP.replace(/\./g, '\\.')}`));
    expect(table).toMatch(new RegExp(`${IN3_IP.replace(/\./g, '\\.')}`));
    const entries = parseNatTable(table);
    for (const e of entries) expect(e.insideGlobalIp).toBe(GW_OUTSIDE);
  });

  it('3 sessions TCP simultanées ssh vers 22 → 3 ports externes distincts, aucune collision', async () => {
    const lab = await buildLab();
    await Promise.all([
      lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in3.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
    ]);
    const table = await lab.gw.executeCommand('show ip nat translations');
    const tcp = parseNatTable(table).filter(e => e.proto === 'tcp' && e.outsideGlobalPort === 22);
    expect(tcp.length).toBeGreaterThanOrEqual(3);
    const externalPorts = tcp.map(e => e.insideGlobalPort);
    expect(new Set(externalPorts).size).toBe(externalPorts.length);
  });

  it('la table NAT permet de retracer sans ambiguïté quel hôte interne = quelle session externe', async () => {
    const lab = await buildLab();
    await Promise.all([
      lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
      lab.in3.executeCommand(`nc -zv ${OUTSIDE_IP} 22`),
    ]);
    const table = await lab.gw.executeCommand('show ip nat translations');
    const tcp = parseNatTable(table).filter(e => e.proto === 'tcp' && e.outsideGlobalPort === 22);
    const bySource = new Map<string, Xlate[]>();
    for (const e of tcp) {
      const arr = bySource.get(e.insideLocalIp) ?? [];
      arr.push(e);
      bySource.set(e.insideLocalIp, arr);
    }
    expect(bySource.has(IN1_IP)).toBe(true);
    expect(bySource.has(IN2_IP)).toBe(true);
    expect(bySource.has(IN3_IP)).toBe(true);
    for (const e of tcp) {
      expect(e.insideGlobalIp).toBe(GW_OUTSIDE);
      expect(e.insideLocalPort).toBeGreaterThanOrEqual(1);
      expect(e.insideGlobalPort).toBeGreaterThanOrEqual(1);
    }
  });

  it('le port source interne (côté LAN) et le port traduit (côté WAN) restent liés durant la session', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    const table = await lab.gw.executeCommand('show ip nat translations');
    const tcp = parseNatTable(table).filter(e => e.proto === 'tcp' && e.insideLocalIp === IN1_IP);
    expect(tcp.length).toBeGreaterThan(0);
    const entry = tcp[0];
    const socketTable = (lab.in1 as unknown as { executor: { socketTable: { getAll: () => Array<{ localPort: number; remotePort: number; remoteAddress: string; protocol: string }> } } }).executor.socketTable;
    const clientSockets = socketTable.getAll()
      .filter(s => s.protocol === 'tcp' && s.remoteAddress === OUTSIDE_IP && s.remotePort === 22);
    const clientLocalPorts = new Set(clientSockets.map(s => s.localPort));
    expect(clientLocalPorts.has(entry.insideLocalPort)).toBe(true);
  });

  it('20 sessions simultanées ne produisent aucune collision de port externe', async () => {
    const lab = await buildLab();
    const runs: Promise<string>[] = [];
    for (let i = 0; i < 20; i++) {
      const client = [lab.in1, lab.in2, lab.in3][i % 3];
      runs.push(client.executeCommand(`nc -zv ${OUTSIDE_IP} 22`));
    }
    await Promise.all(runs);
    const table = await lab.gw.executeCommand('show ip nat translations');
    const tcp = parseNatTable(table).filter(e => e.proto === 'tcp' && e.outsideGlobalPort === 22);
    const externalPorts = tcp.map(e => `${e.insideGlobalIp}:${e.insideGlobalPort}`);
    expect(new Set(externalPorts).size).toBe(externalPorts.length);
  });

  it('la table NAT référence uniquement des ports globaux dans la plage PAT (1024-65535)', async () => {
    const lab = await buildLab();
    await lab.in1.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    await lab.in2.executeCommand(`nc -zv ${OUTSIDE_IP} 22`);
    const table = await lab.gw.executeCommand('show ip nat translations');
    const tcp = parseNatTable(table).filter(e => e.proto === 'tcp');
    for (const e of tcp) {
      expect(e.insideGlobalPort).toBeGreaterThanOrEqual(1024);
      expect(e.insideGlobalPort).toBeLessThanOrEqual(65535);
    }
  });
});
