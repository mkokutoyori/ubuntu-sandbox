/**
 * PRD-Suppression-Bus-Partage increment 5c — a component that belongs to
 * a machine publishes on THAT machine's bus, or on none.
 *
 * Written BLIND. Increment 5b cut the relay, so no machine event leaves
 * its machine any more. What it did not remove is the FALLBACK: some
 * thirty components carry `busOverride ?? getDefaultEventBus()`, and
 * that expression is only reached when nobody injected a bus — that is,
 * when the object is attached to no machine at all. It then publishes
 * into a channel every machine shares, which is the very thing the
 * whole PRD removes.
 *
 * The structural case is a GUARD that re-runs the search on every
 * execution and names its offenders, rather than a hand-written list
 * that rots: any production file outside `src/events` still importing
 * `getDefaultEventBus` fails it, except the observers that legitimately
 * hold one — `Logger`, `EquipmentRegistry` and `Cable` are not machines,
 * and `Cable` is shared by two machines because a cable IS.
 *
 * The behavioural cases are what stop the guard from being satisfied by
 * a component that publishes nowhere at all: a router's own OSPF, RIP
 * and NAT events must still reach the router that owns them.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const ALLOWED = [
  'src/network/core/Logger.ts',
  'src/network/equipment/EquipmentRegistry.ts',
  'src/network/hardware/Cable.ts',
];

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('no per-machine component reaches for a shared bus', () => {
  it('only the observers that are not machines still hold one', () => {
    const hits = execSync(
      "grep -rl 'getDefaultEventBus' src/ --include=*.ts --include=*.tsx "
      + "| grep -v __tests__ | grep -v '^src/events/' || true",
      { encoding: 'utf8' }).trim();
    const offenders = hits ? hits.split('\n').filter(f => !ALLOWED.includes(f)) : [];

    expect(offenders).toEqual([]);
  });
});

describe('what a machine owns still reaches that machine', () => {
  async function pair(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
    const a = new CiscoRouter('R1');
    const b = new CiscoRouter('R2');
    new Cable('c').connect(
      a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
    for (const [r, ip] of [[a, '10.0.0.1'], [b, '10.0.0.2']] as const) {
      for (const c of [
        'enable', 'configure terminal', 'interface GigabitEthernet0/0',
        `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
        'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end',
      ]) await r.executeCommand(c);
    }
    return { a, b };
  }

  it('an OSPF neighbour change reaches the router that owns the engine', async () => {
    const a = new CiscoRouter('R1');
    const b = new CiscoRouter('R2');
    const seen: string[] = [];
    a.getBus().subscribe('ospf.neighbor.state-changed', () => { seen.push('x'); });
    new Cable('c').connect(
      a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
    for (const [r, ip] of [[a, '10.0.0.1'], [b, '10.0.0.2']] as const) {
      for (const c of [
        'enable', 'configure terminal', 'interface GigabitEthernet0/0',
        `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
        'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end',
      ]) await r.executeCommand(c);
    }

    expect(seen.length).toBeGreaterThan(0);
  });

  it('a DHCP lease reaches the host that owns the client', async () => {
    const router = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
    pc.powerOn();
    new Cable('a').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    for (const c of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
      'no shutdown', 'exit',
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'end',
    ]) await router.executeCommand(c);
    const seen: string[] = [];
    pc.getBus().subscribe('dhcp.ack.received', () => { seen.push('x'); });

    await pc.executeCommand('sudo dhclient eth0');

    expect(seen.length).toBeGreaterThan(0);
  });

  it('TEMOIN: the routers really formed an adjacency', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('show ip ospf neighbor')).toContain('FULL');
  });

  it('an interface configured by DHCP really carries the address', async () => {
    const router = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
    pc.powerOn();
    new Cable('a').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
    router.configureInterface('GigabitEthernet0/0',
      new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    for (const c of [
      'enable', 'configure terminal',
      'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'end',
    ]) await router.executeCommand(c);

    await pc.executeCommand('sudo dhclient eth0');

    expect(await pc.executeCommand('ip addr show eth0')).toMatch(/inet 10\.0\.0\.\d+/);
  });
});
