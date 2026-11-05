/*
 * Probe: `config router bfd` > `config neighbor` (FortiOS CLI Reference 7.4.12 p.1050) starts a real BFD session
 * (RFC 5880 control packets on UDP 3784, over the cable) with the shared BFD agent the Cisco/Huawei routers use ;
 * `get router info bfd neighbor` shows it. Measured before: "unknown configuration path "router bfd"".
 * The column layout of the view follows what a FortiGate prints ; the reference has no sample (no transcript).
 * `router bgp` > `neighbor` > `set bfd enable` (p.1053) provisions the session and holds the BGP session down while
 * the BFD session is not up. Discriminated with git stash on src/network: 7 of 9 fall before the fix; the two
 * witnesses (the units reach each other; the BGP pair establishes) pass either way. The pair is configured
 * 1.1.1.1 first: the reverse order does not establish, recorded in TODO.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab(withBfd = true) {
  const bench = new LabWorkbench();
  const a = bench.place('firewall-fortinet', 'A', 0, 0);
  const b = bench.place('firewall-fortinet', 'B', 0, 0);
  bench.connect(a, 'port1', b, 'port1');
  const side = (ip: string, peer: string) => [
    'config system interface', 'edit port1', 'set mode static', `set ip ${ip} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    ...(withBfd ? ['config router bfd', 'config neighbor', `edit ${peer}`, 'set interface "port1"', 'next', 'end', 'end'] : []),
  ];
  const typedA = await bench.shell(a, ...side('10.5.0.1', '10.5.0.2'));
  const typedB = await bench.shell(b, ...side('10.5.0.2', '10.5.0.1'));
  return { a, b, bench, typed: typedA + typedB };
}

describe('router bfd', () => {
  it('witness: the two units reach each other', async () => {
    const { a } = await lab(false);
    expect(await a.executeCommand('execute ping 10.5.0.2')).toContain('received');
  });

  it('accepts the configuration', async () => {
    const { typed } = await lab();
    expect(typed).not.toMatch(/Command fail|unknown configuration path/);
  });

  it('the session reaches UP in the neighbor view of both units', async () => {
    const { a, b } = await lab();
    expect(await a.executeCommand('get router info bfd neighbor')).toMatch(/10\.5\.0\.1\s+10\.5\.0\.2\s+UP\s+port1/);
    expect(await b.executeCommand('get router info bfd neighbor')).toMatch(/10\.5\.0\.2\s+10\.5\.0\.1\s+UP\s+port1/);
  });

  it('the running configuration reproduces what was typed', async () => {
    const { a } = await lab();
    const shown = await a.executeCommand('show router bfd');
    expect(shown).toContain('edit "10.5.0.2"');
    expect(shown).toContain('set interface "port1"');
  });

  it('the session goes DOWN when its link goes down', async () => {
    const { a } = await lab();
    await a.executeCommand('config system interface');
    await a.executeCommand('edit port1');
    await a.executeCommand('set status down');
    await a.executeCommand('end');
    expect(await a.executeCommand('get router info bfd neighbor')).toMatch(/10\.5\.0\.2\s+DOWN/);
  });

  it('the new words are announced by ?', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('config router ?')).toContain('bfd');
  });
});

describe('router bgp neighbor bfd', () => {
  async function bgpPair() {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    const bench = new LabWorkbench();
    const a = bench.place('firewall-fortinet', 'A', 0, 0);
    const b = bench.place('firewall-fortinet', 'B', 0, 0);
    bench.connect(a, 'port1', b, 'port1');
    const side = (ip: string, peer: string, asn: number, peerAsn: number, id: string) => [
      'config system interface', 'edit port1', 'set mode static', `set ip ${ip} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
      'config router bgp', `set as ${asn}`, `set router-id ${id}`, 'config neighbor', `edit ${peer}`, `set remote-as ${peerAsn}`, 'set bfd enable', 'next', 'end', 'end',
    ];
    await bench.shell(b, ...side('10.6.0.2', '10.6.0.1', 65002, 65001, '1.1.1.1'));
    await bench.shell(a, ...side('10.6.0.1', '10.6.0.2', 65001, 65002, '2.2.2.2'));
    clock.advance(120_000);
    return { a, b, clock };
  }

  const established = (summary: string) => /10\.6\.0\.2\s+4\s+65002\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\S+\s+\d+\s*$/m.test(summary);

  it('witness: the BGP session is established', async () => {
    const { a } = await bgpPair();
    expect(established(await a.executeCommand('get router info bgp summary'))).toBe(true);
  });

  it('set bfd enable starts the BFD session without any router bfd entry', async () => {
    const { a } = await bgpPair();
    expect(await a.executeCommand('get router info bfd neighbor')).toMatch(/10\.6\.0\.2\s+UP\s+port1/);
  });

  it('a BFD session that goes down takes the BGP session down, and its recovery brings it back', async () => {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const peer = new CiscoRouter('R1', 200, 0);
    new Cable('transit').connect(firewall.getPort('port2')!, peer.getPort('GigabitEthernet0/0')!);
    const type = async (device: { executeCommand(c: string): Promise<string> }, lines: string[]) => {
      for (const line of lines) await device.executeCommand(line);
    };
    await type(firewall, ['config system interface', 'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']);
    await type(peer, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
      'router bgp 65002', 'bgp router-id 2.2.2.2', 'neighbor 10.1.0.1 remote-as 65001', 'end']);
    await type(firewall, ['config router bgp', 'set as 65001', 'set router-id 1.1.1.1', 'config neighbor', 'edit "10.1.0.2"',
      'set remote-as 65002', 'set bfd enable', 'next', 'end', 'end']);
    clock.advance(120_000);
    const seen = () => peer.executeCommand('show ip bgp neighbors 10.1.0.1');
    expect(await seen()).toContain('BGP state = Established');
    const flip = (newState: 'down' | 'up') => firewall.getBus().publish({
      topic: 'bfd.session.changed',
      payload: { deviceId: firewall.getId(), hostname: 'FGT', iface: 'port2', neighborIp: '10.1.0.2', oldState: 'up', newState, diagnostic: 'none', reason: 'timeout' },
    } as never);
    flip('down');
    clock.advance(240_000);
    expect(await seen()).not.toContain('BGP state = Established');
    flip('up');
    clock.advance(240_000);
    expect(await seen()).toContain('BGP state = Established');
  });
});
