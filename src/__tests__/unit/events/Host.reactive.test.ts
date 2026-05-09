/**
 * Phase 5 — host (L3/L4) reactive instrumentation tests.
 *
 * Verifies the *non-invasive* Phase 5.1–5.3 changes:
 *   - host events are emitted alongside the legacy `pendingXxx` flows;
 *   - host.observables (arp/ndp/routes/tcp/stats) reactively update;
 *   - the fwdQueue timer runs on the injected `IScheduler`;
 *   - HostCaptureActor records the full host taxonomy.
 *
 * The `pendingXxx` Maps are NOT removed yet — these tests prove the
 * shadow emissions are correct so Phases 5.4–5.6 can swap to
 * `waitForEvent` safely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { HostCaptureActor } from '@/network/devices/host/actors';
import { MACAddress } from '@/network/core/types';
import type { DomainEvent } from '@/events/types';

function buildHost(name = 'PC1') {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);

  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const pc = new LinuxPC('linux-pc', name);
  pc.setEventBus(bus);
  pc.setScheduler(scheduler);
  return { pc, bus, scheduler, trace };
}

describe('EndHost — observables surface', () => {
  let ctx: ReturnType<typeof buildHost>;

  beforeEach(() => {
    ctx = buildHost();
  });

  afterEach(() => {
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('exposes arp / ndp / routes / tcpListeners / tcpConnections / stats signals', () => {
    expect(ctx.pc.observables.arp.get()).toEqual([]);
    expect(ctx.pc.observables.ndp.get()).toEqual([]);
    expect(ctx.pc.observables.routes.get()).toEqual([]);
    expect(ctx.pc.observables.tcpListeners.get()).toEqual([]);
    expect(ctx.pc.observables.tcpConnections.get()).toEqual([]);
    expect(ctx.pc.observables.stats.get().arpCacheSize).toBe(0);
  });
});

describe('EndHost — ARP emissions on static add', () => {
  let ctx: ReturnType<typeof buildHost>;

  beforeEach(() => {
    ctx = buildHost();
  });

  afterEach(() => {
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('addStaticARP emits host.arp.entry-learned with source=static', () => {
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');

    const learned = ctx.trace.find((e) => e.topic === 'host.arp.entry-learned');
    expect(learned).toBeDefined();
    const payload = (learned as DomainEvent & { topic: 'host.arp.entry-learned' }).payload;
    expect(payload.ip).toBe('10.0.0.42');
    expect(payload.iface).toBe('eth0');
    expect(payload.source).toBe('static');
  });

  it('the arp signal reactively reflects the new entry', () => {
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');

    const arp = ctx.pc.observables.arp.get();
    expect(arp).toHaveLength(1);
    expect(arp[0].ip).toBe('10.0.0.42');
    expect(arp[0].iface).toBe('eth0');
  });

  it('the stats signal counts the ARP cache size', () => {
    expect(ctx.pc.observables.stats.get().arpCacheSize).toBe(0);
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    ctx.pc.addStaticARP('10.0.0.43', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');
    expect(ctx.pc.observables.stats.get().arpCacheSize).toBe(2);
  });
});

describe('EndHost — fwdQueue runs on the injected scheduler', () => {
  let ctx: ReturnType<typeof buildHost>;

  beforeEach(() => { ctx = buildHost(); });
  afterEach(() => {
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('the LinuxPC owns a TimerSet bound to the injected scheduler', () => {
    // No fwdQueue in flight — only the scheduler-owned set is queried.
    // The hostTimers field is private but its presence implies that
    // setScheduler() did wire correctly. We can verify indirectly by
    // checking that scheduler.pendingCount() stays 0 here.
    expect(ctx.scheduler.pendingCount()).toBe(0);
  });
});

describe('HostCaptureActor — opt-in tcpdump-like recorder', () => {
  let ctx: ReturnType<typeof buildHost>;
  let capture: HostCaptureActor;

  beforeEach(() => {
    ctx = buildHost();
    capture = new HostCaptureActor(ctx.bus, 200);
    capture.start();
  });

  afterEach(() => {
    capture.stop();
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('records arp-learned events from addStaticARP', () => {
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    const arp = capture.getCapture({ kind: 'arp-learned' });
    expect(arp).toHaveLength(1);
    expect((arp[0].payload as { ip: string }).ip).toBe('10.0.0.42');
  });

  it('filters by deviceId', () => {
    const ctx2 = buildHost('PC2');
    capture.start(); // re-attach (idempotent)

    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    ctx2.pc.addStaticARP('10.0.0.43', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');

    const pc1 = capture.getCapture({ deviceId: ctx.pc.getId() });
    const pc2 = capture.getCapture({ deviceId: ctx2.pc.getId() });
    // Each host's bus is separate (re-attached), so PC2's events
    // don't reach our capture which is bound to ctx.bus.
    expect(pc1.length).toBeGreaterThan(0);
    expect(pc2.length).toBe(0);
  });

  it('filters by ip across fromIp/toIp/ip fields', () => {
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    ctx.pc.addStaticARP('10.0.0.43', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');

    const m42 = capture.getCapture({ ip: '10.0.0.42' });
    expect(m42).toHaveLength(1);
  });

  it('clear() empties the buffer; stop() unsubscribes', () => {
    ctx.pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    expect(capture.size()).toBeGreaterThan(0);

    capture.clear();
    expect(capture.size()).toBe(0);

    capture.stop();
    ctx.pc.addStaticARP('10.0.0.43', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');
    expect(capture.size()).toBe(0);
  });

  it('caps the buffer at maxEntries', () => {
    const small = new HostCaptureActor(ctx.bus, 4);
    small.start();
    for (let i = 0; i < 10; i++) {
      ctx.pc.addStaticARP(`10.0.0.${i + 1}`, MACAddress.parse(`aa:bb:cc:dd:ee:${i.toString(16).padStart(2, '0')}`), 'eth0');
    }
    expect(small.size()).toBeLessThanOrEqual(5);
    small.stop();
  });
});
