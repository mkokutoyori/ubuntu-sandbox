import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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
    for (let flush = 0; flush < 12; flush++) await Promise.resolve();
  }
}

async function buildLab() {
  const r1 = new HuaweiRouter('R1');
  const r2 = new HuaweiRouter('R2');
  const pc = new LinuxPC('PC1');

  new Cable('c-r1-r2').connect(
    r1.getPort('GE0/0/0')!, r2.getPort('GE0/0/0')!);
  const access = new Cable('c-r2-pc');
  access.connect(r2.getPort('GE0/0/1')!, pc.getPort('eth0')!);

  for (const command of [
    'system-view',
    'interface GE0/0/0', 'ip address 10.0.0.1 255.255.255.252', 'undo shutdown', 'quit',
    'ip route-static 192.168.1.0 255.255.255.0 10.0.0.2',
  ]) await r1.executeCommand(command);

  for (const command of [
    'system-view',
    'interface GE0/0/0', 'ip address 10.0.0.2 255.255.255.252', 'undo shutdown', 'quit',
    'interface GE0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'undo shutdown', 'quit',
  ]) await r2.executeCommand(command);

  pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('192.168.1.1'));

  return { r1, r2, pc, access };
}

async function defineIcmpTest(
  router: HuaweiRouter,
  extra: string[] = [],
): Promise<void> {
  for (const command of [
    'nqa test-instance admin test1',
    'test-type icmp',
    'destination-address ipv4 192.168.1.10',
    ...extra,
    'start now',
    'quit',
  ]) await router.executeCommand(command);
}

describe('NQA - the probe really measures', () => {
  it('an icmp test yields a batch of three probes and an RTT', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    await settle(15000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.sent).toBe(3);
    expect(test.received).toBe(3);
    expect(test.completion).toBe('success');

    const results = await r1.executeCommand('display nqa results test-instance admin test1');
    expect(results).toContain('NQA entry(admin, test1)');
    expect(results).toContain('Send operation times: 3');
    expect(results).toContain('Receive response times: 3');
    expect(results).toContain('Completion:success');
    expect(results).toContain('Destination ip address:192.168.1.10');
  });

  it('THE CASE: the target dies, R1 route does not move, the test fails', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await settle(15000);
    expect(r1.getNqaService().get('admin', 'test1')!.completion).toBe('success');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    expect(r1.getPort('GE0/0/0')!.isOperationallyUp()).toBe(true);
    expect(r1.getRoutingTable().some((route) =>
      String(route.network) === '192.168.1.0')).toBe(true);

    await settle(30000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.received).toBe(0);
    expect(test.completion).not.toBe('success');
    const results = await r1.executeCommand('display nqa results test-instance admin test1');
    expect(results).toContain('Receive response times: 0');
  });
});

describe('NQA - what sets it apart from IP SLA', () => {
  it('frequency 0 (the VRP default) runs ONE pass then stops', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    await settle(15000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.attempts).toBe(1);
    expect(test.finished).toBe(true);
    expect(await r1.executeCommand('display nqa results test-instance admin test1'))
      .toContain('The test is finished');

    await settle(60000);
    expect(r1.getNqaService().get('admin', 'test1')!.attempts).toBe(1);
  });

  it('frequency 10 repeats the passes', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await settle(15000);
    const first = r1.getNqaService().get('admin', 'test1')!.attempts;
    expect(first).toBeGreaterThanOrEqual(1);

    await settle(25000);
    expect(r1.getNqaService().get('admin', 'test1')!.attempts).toBeGreaterThan(first);
  });

  it('probe-count sets the batch size', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['probe-count 5', 'interval milliseconds 20']);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.sent).toBe(5);
    expect(test.received).toBe(5);
    expect(test.history.length).toBe(5);
  });

  it('fail-percent: one loss out of three is still a success by default', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['interval milliseconds 20']);
    await settle(5000);

    const service = r1.getNqaService();
    const test = service.get('admin', 'test1')!;
    const runtime = service.runtimeOf(test)!;
    expect(runtime.config.failPercent).toBe(100);

    await r1.executeCommand('nqa test-instance admin test1');
    expect(await r1.executeCommand('fail-percent 1')).toBe('');
    expect(service.runtimeOf(test)!.config.failPercent).toBe(1);
  });

  it('threshold rtd counts crossings without failing the test', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, ['threshold rtd 5000', 'interval milliseconds 20']);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'test1')!;
    expect(test.completion).toBe('success');
    expect(await r1.executeCommand('display nqa results test-instance admin test1'))
      .toContain('RTD OverThresholds number: 0');
  });

  it('a test-type VRP knows but this simulator cannot measure is refused', async () => {
    const { r1 } = await buildLab();
    await r1.executeCommand('nqa test-instance admin test2');
    const refusal = await r1.executeCommand('test-type lspping');
    expect(refusal).toContain('not supported in this simulator');
    expect(refusal).toContain('MPLS');
    expect(r1.getNqaService().get('admin', 'test2')!.testType).toBeNull();
  });

  it('a nonexistent test-type is refused, not stored', async () => {
    const { r1 } = await buildLab();
    await r1.executeCommand('nqa test-instance admin test3');
    expect(await r1.executeCommand('test-type nimportequoi')).toContain('Wrong parameter');
    expect(r1.getNqaService().get('admin', 'test3')!.testType).toBeNull();
  });
});

describe('NQA - track nqa really conditions a route', () => {
  it('the static route leaves the table when the test fails', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await r1.executeCommand('ip route-static 172.16.0.0 255.255.0.0 10.0.0.2 track nqa admin test1');
    await settle(15000);

    expect(r1.getNqaService().isTrackUp('admin', 'test1')).toBe(true);
    expect(await r1.executeCommand('display ip routing-table')).toContain('172.16.0.0');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(30000);

    expect(r1.getNqaService().isTrackUp('admin', 'test1')).toBe(false);
    expect(await r1.executeCommand('display ip routing-table')).not.toContain('172.16.0.0');
  });

  it('the default route is conditioned too', async () => {
    const { r1, pc, access } = await buildLab();
    await defineIcmpTest(r1, ['frequency 10']);
    await r1.executeCommand('ip route-static 0.0.0.0 0.0.0.0 10.0.0.2 track nqa admin test1');
    await settle(15000);
    expect(await r1.executeCommand('display ip routing-table')).toContain('0.0.0.0/0');

    access.disconnect();
    pc.getPort('eth0')!.setUp(false);
    await settle(30000);

    expect(await r1.executeCommand('display ip routing-table')).not.toContain('0.0.0.0/0');
  });
});

describe('NQA - the server', () => {
  it('nqa-server udpecho opens a port a udp test reaches', async () => {
    const { r1, r2 } = await buildLab();
    for (const command of [
      'nqa-server udpecho 10.0.0.2 5000',
    ]) await r2.executeCommand(command);

    for (const command of [
      'nqa test-instance admin udp1',
      'test-type udp',
      'destination-address ipv4 10.0.0.2',
      'destination-port 5000',
      'interval milliseconds 20',
      'start now',
      'quit',
    ]) await r1.executeCommand(command);
    await settle(5000);

    const test = r1.getNqaService().get('admin', 'udp1')!;
    expect(test.received).toBe(3);
    expect(test.completion).toBe('success');
    expect(await r2.executeCommand('display nqa-server')).toContain('udpecho server: 10.0.0.2');
  });

  it('with no nqa-server, the same test fails', async () => {
    const { r1 } = await buildLab();
    for (const command of [
      'nqa test-instance admin udp1',
      'test-type udp',
      'destination-address ipv4 10.0.0.2',
      'destination-port 5000',
      'interval milliseconds 20',
      'start now',
      'quit',
    ]) await r1.executeCommand(command);
    await settle(20000);

    const test = r1.getNqaService().get('admin', 'udp1')!;
    expect(test.received).toBe(0);
    expect(test.completion).not.toBe('success');
  });
});

describe('NQA - the configuration reads back as it was typed', () => {
  it('display current-configuration reproduces the nqa test-instance block', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1, [
      'frequency 30', 'probe-count 5', 'timeout 2',
      'description sonde-wan', 'threshold rtd 200',
    ]);
    await r1.executeCommand('nqa-server udpecho 10.0.0.1 5000');

    const config = await r1.executeCommand('display current-configuration');
    expect(config).toContain('nqa test-instance admin test1');
    expect(config).toContain(' test-type icmp');
    expect(config).toContain(' destination-address ipv4 192.168.1.10');
    expect(config).toContain(' frequency 30');
    expect(config).toContain(' probe-count 5');
    expect(config).toContain(' timeout 2');
    expect(config).toContain(' description sonde-wan');
    expect(config).toContain(' threshold rtd 200');
    expect(config).toContain('nqa-server udpecho 10.0.0.1 5000');
  });

  it('VRP default values are not rendered', async () => {
    const { r1 } = await buildLab();
    await defineIcmpTest(r1);
    const config = await r1.executeCommand('display current-configuration');
    expect(config).toContain('nqa test-instance admin test1');
    expect(config).not.toContain(' frequency 0');
    expect(config).not.toContain(' probe-count 3');
    expect(config).not.toContain(' timeout 3');
  });
});

describe('NQA - the shared engine did not change behaviour for IOS', () => {
  it('an IP SLA operation keeps one probe per cycle', async () => {
    const router = new CiscoRouter('R1');
    const pc = new LinuxPC('PC1');
    new Cable('c').connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    pc.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.252'));

    for (const command of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'ip sla 1', 'icmp-echo 10.0.0.2', 'frequency 5', 'exit',
      'ip sla schedule 1 life forever start-time now',
      'end',
    ]) await router.executeCommand(command);

    await settle(200);
    const runtime = router.getIpSlaEngine().getOperation(1)!;
    expect(runtime.config.aggregateProbes).toBe(1);
    expect(runtime.lastBatch).toBeNull();
    expect(runtime.counters.successes).toBe(1);
  });
});
