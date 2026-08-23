import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { __setDefaultScheduler } from '@/events/Scheduler';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

function converger(secondes = 60): void {
  horloge.advance(secondes * 1000);
}

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);

  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);

  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static',
    'set ip 192.168.100.99 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await taper(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 10.255.255.254',
    'network 192.168.100.0 0.0.0.255 area 0',
    'default-information originate always', 'end',
  ]);
  await taper(fgt, [
    'config system interface', 'edit "lo-ospf"',
    'set vdom "root"', 'set type loopback',
    'set ip 10.255.255.1 255.255.255.255', 'next', 'end',
    'config router ospf',
    'set router-id 10.255.255.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network',
    'edit 1', 'set prefix 192.168.100.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'edit 2', 'set prefix 192.168.10.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'end',
    'set passive-interface "port2"',
    'end',
  ]);
  converger();
  await fgt.executeCommand('get router info ospf neighbor');
  return { fgt, r1 };
}

describe('`get router info ospf database` rend la base', () => {
  it('la vue existe et nomme le Router ID de la machine', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf database');

    expect(vue).not.toMatch(/Command fail|unknown configuration path/i);
    expect(vue).toContain('OSPF Router with ID (10.255.255.1)');
  });

  it('la section des LSA de routeur porte l\'aire et ses colonnes', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf database');

    expect(vue).toContain('Router Link States (Area 0.0.0.0)');
    expect(vue).toContain(
      'Link ID         ADV Router      Age  Seq#       CkSum  Link count');
  });

  it('une ligne de LSA porte les champs au format de zebra', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf database');
    const ligne = vue.split('\n').find(l => l.startsWith('10.255.255.1 '));

    expect(ligne).toBeDefined();
    expect(ligne).toMatch(
      /^10\.255\.255\.1 {3}10\.255\.255\.1 {3}\s*\d+ 0x[0-9a-f]{8} 0x[0-9a-f]{4}/);
  });

  it('les deux routeurs de l\'aire figurent dans la base', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf database');

    expect(vue).toContain('10.255.255.1');
    expect(vue).toContain('10.255.255.254');
  });

  it('la route par defaut apprise parait en LSA externe', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf database');

    expect(vue).toContain('AS External Link States');
    expect(vue).toMatch(/E2 0\.0\.0\.0\/0 \[0x0\]/);
  });

  it('`brief` est accepte et rend la meme chose', async () => {
    const { fgt } = await laboratoire();

    const brief = await fgt.executeCommand('get router info ospf database brief');

    expect(brief).not.toMatch(/Command fail|unknown configuration path/i);
    expect(brief).toContain('OSPF Router with ID');
  });
});

describe('`get router info ospf interface` rend l\'etat des interfaces', () => {
  it('la vue existe et decrit l\'interface de transit', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf interface');

    expect(vue).not.toMatch(/Command fail|unknown configuration path/i);
    expect(vue).toContain('port1 is up');
    expect(vue).toContain(
      'Internet Address 192.168.100.99/24, Broadcast 192.168.100.255, Area 0.0.0.0');
  });

  it('elle nomme le type de reseau, le cout et l\'etat', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf interface');

    expect(vue).toMatch(
      /Router ID 10\.255\.255\.1, Network Type BROADCAST, Cost: \d+/);
    expect(vue).toMatch(/Transmit Delay is \d+ sec, State \S+, Priority \d+/);
  });

  it('elle rend les temporisateurs et le compte de voisins', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf interface');

    expect(vue).toContain(
      'Timer intervals configured, Hello 10s, Dead 40s, Wait 40s, Retransmit 5');
    expect(vue).toMatch(/Neighbor Count is \d+, Adjacent neighbor count is \d+/);
  });

  it('une interface PASSIVE le dit au lieu d\'annoncer des Hello', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf interface port2');

    expect(vue).toContain('No Hellos (Passive interface)');
  });

  it('une interface hors OSPF le dit', async () => {
    const { fgt } = await laboratoire();

    const vue = await fgt.executeCommand('get router info ospf interface port3');

    expect(vue).toContain('OSPF not enabled on this interface');
  });

  it('un nom d\'interface inconnu est refuse', async () => {
    const { fgt } = await laboratoire();

    expect(await fgt.executeCommand('get router info ospf interface portZZ'))
      .toMatch(/Command fail|unknown/i);
  });
});
