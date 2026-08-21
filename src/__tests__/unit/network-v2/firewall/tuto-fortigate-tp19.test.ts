import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

function converger(secondes = 60): void {
  horloge.advance(secondes * 1000);
}

interface Cmd { executeCommand(c: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  const pcLan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);

  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);
  new Cable('lan').connect(pcLan.getPort('eth0')!, fgt.getPort('port2')!);

  await taper(pcLan, [
    'ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1',
  ]);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
  ]);

  await taper(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback0',
    'ip address 10.255.255.254 255.255.255.255', 'exit',
    'end',
  ]);
  return { fgt, r1, pcLan };
}

async function ospfSurR1(r1: CiscoRouter): Promise<string[]> {
  return taper(r1, [
    'configure terminal',
    'router ospf 1',
    'router-id 10.255.255.254',
    'network 192.168.100.0 0.0.0.255 area 0',
    'passive-interface GigabitEthernet0/0',
    'default-information originate always',
    'end',
  ]);
}

async function ospfSurFgt(fgt: FortiGate): Promise<string[]> {
  return taper(fgt, [
    'config system interface', 'edit "lo-ospf"',
    'set vdom "root"', 'set type loopback',
    'set ip 10.255.255.1 255.255.255.255', 'next', 'end',
    'config router ospf',
    'set router-id 10.255.255.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network',
    'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'edit 2', 'set prefix 192.168.10.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'edit 3', 'set prefix 192.168.20.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'end',
    'set passive-interface "port2" "port3"',
    'end',
  ]);
}

describe('TP 19 — OSPF entre le pare-feu et R1', () => {
  it('etape 2 : une interface de BOUCLAGE se declare sur le pare-feu', async () => {
    const { fgt } = await laboratoire();
    propre(await taper(fgt, [
      'config system interface', 'edit "lo-ospf"',
      'set vdom "root"', 'set type loopback',
      'set ip 10.255.255.1 255.255.255.255', 'next', 'end',
    ]));

    const conf = await fgt.executeCommand('show system interface');
    expect(conf).toContain('edit "lo-ospf"');
    expect(conf).toContain('set type loopback');
    expect(await fgt.executeCommand('get system interface'))
      .toContain('10.255.255.1');
  });

  it('etape 2 : la configuration OSPF se declare et se relit', async () => {
    const { fgt } = await laboratoire();
    propre(await ospfSurFgt(fgt));

    const conf = await fgt.executeCommand('show router ospf');
    expect(conf).toContain('set router-id 10.255.255.1');
    expect(conf).toContain('set prefix 192.168.10.0 255.255.255.0');
    expect(conf).toContain('set passive-interface "port2" "port3"');
  });

  it('etape 2 : un router-id nul est refuse', async () => {
    const { fgt } = await laboratoire();
    await fgt.executeCommand('config router ospf');
    await fgt.executeCommand('set router-id 0.0.0.0');
    const refus = await fgt.executeCommand('end');

    expect(refus).toMatch(/Command fail|invalid/i);
  });

  it('etape 3 : l\'adjacence atteint FULL des deux cotes', async () => {
    const { fgt, r1 } = await laboratoire();
    await ospfSurR1(r1);
    await ospfSurFgt(fgt);
    converger();

    const cotePareFeu = await fgt.executeCommand('get router info ospf neighbor');
    expect(cotePareFeu).toContain('10.255.255.254');
    expect(cotePareFeu).toMatch(/Full/);
    expect(cotePareFeu).toContain('192.168.100.1');
    expect(cotePareFeu).toContain('port1');

    const coteRouteur = await r1.executeCommand('show ip ospf neighbor');
    expect(coteRouteur).toContain('10.255.255.1');
    expect(coteRouteur).toMatch(/FULL/i);
  });

  it('etape 3 : R1 apprend les reseaux internes SANS route statique', async () => {
    const { fgt, r1 } = await laboratoire();
    await ospfSurR1(r1);
    await ospfSurFgt(fgt);
    converger();

    const table = await r1.executeCommand('show ip route ospf');
    expect(table).toContain('192.168.10.0');
    expect(table).toContain('192.168.20.0');
  });

  it('etape 4 : la vue par PROTOCOLE existe et ne rend que ce protocole', async () => {
    const { fgt, r1 } = await laboratoire();
    await ospfSurR1(r1);
    await ospfSurFgt(fgt);
    converger();

    const vue = await fgt.executeCommand('get router info routing-table ospf');
    expect(vue).not.toMatch(/Command fail|unknown configuration path/i);
    expect(vue).toContain('O - OSPF');
    expect(vue).not.toMatch(/^C\s+192\.168\.10\.0/m);

    expect(await fgt.executeCommand('get router info routing-table connected'))
      .toMatch(/C\s+192\.168\.10\.0/);
  });

  it('etape 4 : `default-information originate always` annonce SANS route par defaut',
    async () => {
      const r1 = new CiscoRouter('R1-SEUL', 0, 0);
      const r2 = new CiscoRouter('R2-SEUL', 200, 0);
      new Cable('lien').connect(
        r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

      await taper(r1, [
        'enable', 'configure terminal', 'interface GigabitEthernet0/1',
        'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
        'router ospf 1', 'router-id 1.1.1.1',
        'network 10.0.0.0 0.0.0.255 area 0',
        'default-information originate always', 'end',
      ]);
      await taper(r2, [
        'enable', 'configure terminal', 'interface GigabitEthernet0/1',
        'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
        'router ospf 1', 'router-id 2.2.2.2',
        'network 10.0.0.0 0.0.0.255 area 0', 'end',
      ]);
      converger();

      expect(await r1.executeCommand('show ip route'))
        .not.toMatch(/^S\*/m);
      expect(await r2.executeCommand('show ip route'))
        .toMatch(/O\*\s+0\.0\.0\.0\/0/);
    });

  it('etape 5 : une coupure fait TOMBER l\'adjacence, le retour la refait',
    async () => {
      const { fgt, r1 } = await laboratoire();
      await ospfSurR1(r1);
      await ospfSurFgt(fgt);
      converger();
      expect(await fgt.executeCommand('get router info ospf neighbor'))
        .toMatch(/Full/);

      await taper(r1, [
        'configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end',
      ]);
      converger();
      expect(await fgt.executeCommand('get router info ospf neighbor'))
        .not.toMatch(/Full/);

      await taper(r1, [
        'configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end',
      ]);
      converger();
      expect(await fgt.executeCommand('get router info ospf neighbor'))
        .toMatch(/Full/);
    });

  it('etape 6 : l\'authentification MD5 se declare', async () => {
    const { fgt } = await laboratoire();
    await ospfSurFgt(fgt);
    converger();

    propre(await taper(fgt, [
      'config router ospf', 'config ospf-interface', 'edit "vers-R1"',
      'set interface "port1"',
      'set authentication md5',
      'config md5-keys', 'edit 1', 'set key "CleOspfLab2026"', 'next', 'end',
      'next', 'end', 'end',
    ]));

    const conf = await fgt.executeCommand('show router ospf');
    expect(conf).toContain('set authentication md5');
    expect(conf).toContain('edit 1');
    expect(conf).not.toContain('CleOspfLab2026');
  });

  it('etape 6 : l\'authentification d\'un SEUL cote coupe l\'adjacence', async () => {
    const { fgt, r1 } = await laboratoire();
    await ospfSurR1(r1);
    await ospfSurFgt(fgt);
    converger();
    expect(await fgt.executeCommand('get router info ospf neighbor'))
      .toMatch(/Full/);

    await taper(fgt, [
      'config router ospf', 'config ospf-interface', 'edit "vers-R1"',
      'set interface "port1"', 'set authentication md5',
      'config md5-keys', 'edit 1', 'set key "CleOspfLab2026"', 'next', 'end',
      'next', 'end', 'end',
    ]);
    converger();

    expect(await fgt.executeCommand('get router info ospf neighbor'))
      .not.toMatch(/Full/);

    await taper(r1, [
      'configure terminal', 'interface GigabitEthernet0/1',
      'ip ospf authentication message-digest',
      'ip ospf message-digest-key 1 md5 CleOspfLab2026', 'end',
    ]);
    converger();

    expect(await fgt.executeCommand('get router info ospf neighbor'))
      .toMatch(/Full/);
  });

  it('une interface PASSIVE n\'a pas de voisin', async () => {
    const { fgt, r1 } = await laboratoire();
    await ospfSurR1(r1);
    await ospfSurFgt(fgt);
    converger();

    const vue = await fgt.executeCommand('get router info ospf neighbor');
    expect(vue).not.toContain('port2');
    expect(vue).not.toContain('port3');
  });
});
