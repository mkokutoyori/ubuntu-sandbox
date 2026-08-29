import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { IPAddress, MACAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

async function settle(ms: number): Promise<void> {
  const step = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.advance(step);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

async function buildLab() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc = new LinuxPC('PC1');

  const transit = new Cable('c-r1-r2');
  transit.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  const access = new Cable('c-r2-pc');
  access.connect(r2.getPort('GigabitEthernet0/1')!, pc.getPort('eth0')!);

  for (const command of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.0 10.0.0.2',
    'end',
  ]) await r1.executeCommand(command);

  for (const command of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]) await r2.executeCommand(command);

  pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('192.168.1.1'));

  return { r1, r2, pc, transit, access };
}

async function configureIcmpEchoSla(router: CiscoRouter, target: string): Promise<void> {
  for (const command of [
    'configure terminal',
    'ip sla 1',
    `icmp-echo ${target}`,
    'frequency 5',
    'exit',
    'ip sla schedule 1 life forever start-time now',
    'track 1 ip sla 1 reachability',
    'exit',
    'end',
  ]) await router.executeCommand(command);
}

describe('IP SLA - the probe is a real round trip', () => {
  it('measures a real RTT toward a live target', async () => {
    const { r1 } = await buildLab();
    await configureIcmpEchoSla(r1, '192.168.1.10');
    await settle(200);

    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.state).toBe('active');
    expect(runtime.lastReturnCode).toBe('ok');
    expect(runtime.counters.successes).toBeGreaterThan(0);
    expect(runtime.counters.failures).toBe(0);

    const statistics = await r1.executeCommand('show ip sla statistics');
    expect(statistics).toContain('Latest operation return code: OK');
    expect(statistics).toMatch(/Number of successes: [1-9]/);
  });

  it('THE CASE: the target dies, R1 cable and route do not move', async () => {
    const { r1, pc, access } = await buildLab();
    await configureIcmpEchoSla(r1, '192.168.1.10');
    await settle(200);
    expect(r1.getIpSlaEngine().getOperation(1)!.lastReturnCode).toBe('ok');
    expect(r1.getTrackService().isUp(1)).toBe(true);
    const successesWhileAlive = r1.getIpSlaEngine().getOperation(1)!.counters.successes;

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);

    const r1Link = r1.getPort('GigabitEthernet0/0')!;
    expect(r1Link.isOperationallyUp()).toBe(true);
    expect(r1.getRoutingTable().some((route) =>
      String(route.network) === '192.168.1.0')).toBe(true);

    await settle(12000);

    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('dropped');
    expect(runtime.counters.failures).toBeGreaterThan(0);
    expect(runtime.counters.successes).toBe(successesWhileAlive);
    expect(r1.getTrackService().isUp(1)).toBe(false);

    const track = await r1.executeCommand('show track 1');
    expect(track).toContain('IP SLA 1 reachability');
    expect(track).toContain('Reachability is Down');
    expect(track).toContain('Latest operation return code: Dropped');
  });

  it('nothing is sent until the operation is scheduled', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'configure terminal', 'ip sla 1', 'icmp-echo 192.168.1.10', 'frequency 5', 'exit', 'end',
    ]) await r1.executeCommand(command);

    await settle(20000);

    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.state).toBe('pending');
    expect(runtime.lastReturnCode).toBeNull();
    expect(runtime.counters.successes + runtime.counters.failures).toBe(0);
    expect(await r1.executeCommand('show ip sla statistics'))
      .toContain('No statistics gathered');
  });

  it('frequency governs the probe cadence', async () => {
    const { r1 } = await buildLab();
    await configureIcmpEchoSla(r1, '192.168.1.10');
    await settle(100);
    const afterFirst = r1.getIpSlaEngine().getOperation(1)!.counters.successes;
    expect(afterFirst).toBe(1);

    await settle(4000);
    expect(r1.getIpSlaEngine().getOperation(1)!.counters.successes).toBe(1);

    await settle(2000);
    expect(r1.getIpSlaEngine().getOperation(1)!.counters.successes).toBe(2);
  });

  it('a shut source interface fails Not connected, without waiting the timeout', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'configure terminal',
      'ip sla 1',
      'icmp-echo 192.168.1.10 source-interface GigabitEthernet0/1',
      'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await r1.executeCommand(command);

    await settle(200);
    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('notConnected');
    expect(runtime.counters.connectionLosses).toBeGreaterThan(0);
  });

  it('life exhausted: the operation goes Inactive and KEEPS its statistics', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'icmp-echo 192.168.1.10', 'frequency 5', 'exit',
      'ip sla schedule 1 life 12 start-time now',
      'end',
    ]) await r1.executeCommand(command);

    await settle(200);
    const successesWhileActive = r1.getIpSlaEngine().getOperation(1)!.counters.successes;
    expect(successesWhileActive).toBeGreaterThan(0);

    await settle(14000);
    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.state).toBe('inactive');
    expect(runtime.counters.successes).toBeGreaterThanOrEqual(successesWhileActive);
    expect(await r1.executeCommand('show ip sla summary')).toContain('^1');
  });
});

describe('IP SLA - reachability and state are not the same question', () => {
  it('an RTT over threshold leaves reachability Up and brings state down', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'icmp-echo 192.168.1.10', 'threshold 0', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'track 1 ip sla 1 reachability', 'exit',
      'track 2 ip sla 1 state', 'exit',
      'end',
    ]) await r1.executeCommand(command);

    await settle(300);

    const runtime = r1.getIpSlaEngine().getOperation(1)!;
    expect(runtime.lastReturnCode).toBe('ok');
    expect(r1.getTrackService().isUp(1)).toBe(true);
    expect(r1.getTrackService().isUp(2)).toBe(true);

    runtime.lastReturnCode = 'overThreshold';
    expect(r1.getIpSlaEngine().isReachable(1)).toBe(true);
    expect(r1.getIpSlaEngine().isWithinThreshold(1)).toBe(false);
    expect(r1.getTrackService().isUp(1)).toBe(true);
    expect(r1.getTrackService().isUp(2)).toBe(false);
  });
});

describe('IP SLA - track applies its anti-flap delay', () => {
  it('delay down holds back an isolated drop', async () => {
    const { r1, access, pc } = await buildLab();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'icmp-echo 192.168.1.10', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'track 1 ip sla 1 reachability',
      'delay down 30',
      'exit', 'end',
    ]) await r1.executeCommand(command);

    await settle(200);
    expect(r1.getTrackService().isUp(1)).toBe(true);

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(12000);

    expect(r1.getIpSlaEngine().getOperation(1)!.lastReturnCode).toBe('dropped');
    expect(r1.getTrackService().isUp(1)).toBe(true);

    await settle(25000);
    expect(r1.getTrackService().isUp(1)).toBe(false);
  });
});

describe('IP SLA - a floating route fails over on the probe', () => {
  it('the track-conditioned route leaves the table when the probe fails', async () => {
    const { r1, access, pc } = await buildLab();
    for (const command of [
      'configure terminal',
      'ip sla 1', 'icmp-echo 192.168.1.10', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'track 1 ip sla 1 reachability', 'exit',
      'ip route 0.0.0.0 0.0.0.0 10.0.0.2 track 1',
      'end',
    ]) await r1.executeCommand(command);

    await settle(200);
    expect(await r1.executeCommand('show ip route')).toMatch(/S\*\s+0\.0\.0\.0\/0/);

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(12000);

    expect(r1.getTrackService().isUp(1)).toBe(false);
    expect(await r1.executeCommand('show ip route')).not.toMatch(/S\*\s+0\.0\.0\.0\/0/);
  });
});
