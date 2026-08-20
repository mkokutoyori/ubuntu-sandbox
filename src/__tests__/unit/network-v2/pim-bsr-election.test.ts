import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { compareBsrCandidate } from '@/network/pim/types';

let vts: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  vts = new VirtualTimeScheduler();
  __setDefaultScheduler(vts);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

/** R1 ── SW ── R2 (── SW ── R3), one shared segment. */
function lab(count = 2) {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  sw.setEventBus(bus);
  const routers: CiscoRouter[] = [];
  for (let i = 0; i < count; i++) {
    const r = new CiscoRouter(`R${i + 1}`);
    r.setEventBus(bus);
    new Cable(`c${i}`).connect(r.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    r.getPort('GigabitEthernet0/0')!
      .configureIP(new IPAddress(`10.0.0.${i + 1}`), new SubnetMask('255.255.255.0'));
    routers.push(r);
  }
  return { bus, sw, routers };
}

async function run(r: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
}

async function enablePim(r: CiscoRouter): Promise<void> {
  await run(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip pim sparse-mode', 'end',
  ]);
}

describe('PIM BSR — candidate comparison (P1)', () => {
  it('higher priority wins', () => {
    expect(compareBsrCandidate(
      { address: '10.0.0.1', priority: 100 },
      { address: '10.0.0.9', priority: 50 })).toBeLessThan(0);
  });

  it('on equal priority the higher address wins', () => {
    expect(compareBsrCandidate(
      { address: '10.0.0.9', priority: 50 },
      { address: '10.0.0.1', priority: 50 })).toBeLessThan(0);
    expect(compareBsrCandidate(
      { address: '10.0.0.1', priority: 50 },
      { address: '10.0.0.9', priority: 50 })).toBeGreaterThan(0);
  });
});

describe('PIM BSR — election on a real segment (P1)', () => {
  it('a lone candidate elects itself', async () => {
    const { routers: [r1] } = lab(1);
    await enablePim(r1);
    await run(r1, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    const cfg = r1.getPimAgent().getConfig();
    expect(cfg.currentBsr?.address).toBe('10.0.0.1');
    expect(cfg.currentBsr?.priority).toBe(100);
  });

  it('the higher-priority candidate wins and the loser accepts it', async () => {
    const { routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    await run(r1, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 10', 'end']);
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 200', 'end']);
    vts.advance(1_000);
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
    expect(r2.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
  });

  it('on equal priority the higher address wins the whole segment', async () => {
    const { routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    await run(r1, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    vts.advance(1_000);
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
    expect(r2.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
  });

  it('a router with no candidacy simply accepts the BSR it hears', async () => {
    const { routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    vts.advance(1_000);
    expect(r1.getPimAgent().getConfig().bsrCandidate).toBeNull();
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
  });

  it('publishes pim.bsr.changed when the BSR is adopted', async () => {
    const { bus, routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    const events: Array<{ newBsrIp: string | null; isSelf: boolean }> = [];
    bus.subscribeWhere('pim.bsr.changed', (p) => p.deviceId === r1.id, (e) => events.push(e.payload));
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    vts.advance(1_000);
    expect(events.some(e => e.newBsrIp === '10.0.0.2' && e.isSelf === false)).toBe(true);
  });

  it('a third router downstream learns the BSR through the relay', async () => {
    const { routers: [r1, r2, r3] } = lab(3);
    for (const r of [r1, r2, r3]) await enablePim(r);
    await run(r3, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 200', 'end']);
    vts.advance(1_000);
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.3');
    expect(r2.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.3');
  });

  it('the BSR is dropped after BS_Timeout with no Bootstrap, and re-elected on return', async () => {
    const { routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    vts.advance(1_000);
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');

    r2.getPimAgent().stop();
    vts.advance(131_000);
    expect(r1.getPimAgent().getConfig().currentBsr).toBeNull();

    r2.getPimAgent().start();
    vts.advance(61_000);
    expect(r1.getPimAgent().getConfig().currentBsr?.address).toBe('10.0.0.2');
  });

  it('show ip pim bsr-router reports whether this system is the BSR', async () => {
    const { routers: [r1, r2] } = lab(2);
    await enablePim(r1);
    await enablePim(r2);
    await run(r2, ['configure terminal', 'ip pim bsr-candidate GigabitEthernet0/0 30 100', 'end']);
    vts.advance(1_000);
    expect(await r2.executeCommand('show ip pim bsr-router'))
      .toMatch(/This system is the Bootstrap Router \(BSR\)/);
    expect(await r1.executeCommand('show ip pim bsr-router'))
      .toMatch(/This system is not the Bootstrap Router \(BSR\)/);
  });

  it('no ip pim bsr-candidate stands the router down', async () => {
    const { routers: [r1] } = lab(1);
    await enablePim(r1);
    await run(r1, [
      'configure terminal',
      'ip pim bsr-candidate GigabitEthernet0/0 30 100',
      'no ip pim bsr-candidate', 'end',
    ]);
    const cfg = r1.getPimAgent().getConfig();
    expect(cfg.bsrCandidate).toBeNull();
    expect(cfg.currentBsr).toBeNull();
  });

  it('rejects an interface with no address and an out-of-range priority', async () => {
    const { routers: [r1] } = lab(1);
    await enablePim(r1);
    await run(r1, ['configure terminal']);
    expect(await r1.executeCommand('ip pim bsr-candidate GigabitEthernet0/1'))
      .toMatch(/has no IP address/);
    expect(await r1.executeCommand('ip pim bsr-candidate GigabitEthernet0/0 30 999'))
      .toMatch(/Invalid input/);
  });
});
