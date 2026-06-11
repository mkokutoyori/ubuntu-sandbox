import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildMutualRedistributionLab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

  await run(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.1.1 255.255.255.0', 'no shutdown', 'exit',
    'router rip', 'network 10.0.0.0', 'network 172.16.0.0', 'end']);
  await run(r3, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.23.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.3.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 3.3.3.3',
    'network 10.0.23.0 0.0.0.255 area 0', 'network 192.168.3.0 0.0.0.255 area 0', 'end']);
  await run(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.0', 'no shutdown', 'exit',
    'router rip', 'network 10.0.12.0', 'redistribute ospf metric 2', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.23.0 0.0.0.255 area 0', 'redistribute rip subnets', 'end']);
  return { r1, r2, r3 };
}

const findRoute = (r: CiscoRouter, type: string, net: string) =>
  r.getRoutingTable().find(rt => rt.type === type && rt.network.toString() === net);

describe('Mutual RIP ↔ OSPF redistribution (two-domain lab)', () => {
  it('the OSPF domain learns RIP-side prefixes as external routes', async () => {
    const { r2, r3 } = await buildMutualRedistributionLab();

    vi.advanceTimersByTime(35_000);
    expect(findRoute(r2, 'rip', '172.16.1.0')).toBeDefined();

    (r2 as unknown as { _ospfAutoConverge?: () => void })._ospfAutoConverge?.();
    (r3 as unknown as { _ospfAutoConverge?: () => void })._ospfAutoConverge?.();

    const external = findRoute(r3, 'ospf', '172.16.1.0');
    expect(external).toBeDefined();

    const show = await r3.executeCommand('show ip route');
    expect(show).toMatch(/O E2.*172\.16\.1\.0/);
  });

  it('the RIP domain learns OSPF-side prefixes with the redistribute metric', async () => {
    const { r1, r2 } = await buildMutualRedistributionLab();

    (r2 as unknown as { _ospfAutoConverge?: () => void })._ospfAutoConverge?.();
    expect(findRoute(r2, 'ospf', '192.168.3.0')).toBeDefined();

    vi.advanceTimersByTime(35_000);

    const learned = findRoute(r1, 'rip', '192.168.3.0');
    expect(learned).toBeDefined();
    expect(learned!.metric).toBe(2);
  });

  it('without redistribute, nothing crosses the boundary', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const r3 = new CiscoRouter('R3');
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
    await run(r1, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 172.16.1.1 255.255.255.0', 'no shutdown', 'exit',
      'router rip', 'network 10.0.0.0', 'network 172.16.0.0', 'end']);
    await run(r3, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.23.3 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 192.168.3.1 255.255.255.0', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 3.3.3.3',
      'network 10.0.23.0 0.0.0.255 area 0', 'network 192.168.3.0 0.0.0.255 area 0', 'end']);
    await run(r2, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.0', 'no shutdown', 'exit',
      'router rip', 'network 10.0.12.0', 'exit',
      'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.23.0 0.0.0.255 area 0', 'end']);

    vi.advanceTimersByTime(35_000);
    (r2 as unknown as { _ospfAutoConverge?: () => void })._ospfAutoConverge?.();
    (r3 as unknown as { _ospfAutoConverge?: () => void })._ospfAutoConverge?.();

    expect(findRoute(r3, 'ospf', '172.16.1.0')).toBeUndefined();
    expect(findRoute(r1, 'rip', '192.168.3.0')).toBeUndefined();
  });
});
