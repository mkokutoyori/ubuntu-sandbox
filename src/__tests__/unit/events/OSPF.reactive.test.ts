/**
 * Phase 4b2-OSPF — reactive integration tests for `OSPFEngine`.
 *
 * Validates the three pillars of the reactive migration:
 *  1. Every native timer is gone — only the injected `IScheduler` runs
 *     hellos, dead-timers, retransmits, SPF throttling and LSA aging.
 *  2. The engine publishes typed `ospf.*` events on its `EventBus`
 *     for FSM transitions, DR/BDR elections, LSA installs/flushes,
 *     SPF runs, route recomputation, and area activation.
 *  3. The observable read-models (`engine.observables.{neighbors,
 *     interfaces, lsdbSummary, routes, runtime}`) reflect the engine's
 *     state without any polling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import type { DomainEvent } from '@/events/types';
import type { LSA, OSPFInterface } from '@/network/ospf/types';
import {
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA,
  OSPF_LS_REFRESH_TIME,
  OSPF_MAX_AGE,
} from '@/network/ospf/types';

function buildEngine(routerId: string) {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const engine = new OSPFEngine(1);
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  engine.setRouterId(routerId);
  engine.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.0');
  return { engine, bus, scheduler, trace };
}

function attachIface(engine: OSPFEngine, name: string, ipAddress: string, areaId = '0.0.0.0'): OSPFInterface {
  const iface: OSPFInterface = {
    name,
    areaId,
    ipAddress,
    mask: '255.255.255.0',
    networkType: 'broadcast',
    state: 'Down',
    helloInterval: 10,
    deadInterval: 40,
    retransmitInterval: 5,
    transmitDelay: 1,
    priority: 1,
    cost: 1,
    passive: false,
    helloTimer: null,
    waitTimer: null,
    dr: '0.0.0.0',
    bdr: '0.0.0.0',
    neighbors: new Map(),
  };
  // Use the public API to register interface with the engine.
  // OSPFEngine exposes `addInterface(...)` indirectly via `interfaceUp(name)`
  // when the underlying map already holds the interface. Tests typically
  // mutate the internal map directly via a helper; we rely on the
  // existing `addInterface` semantics if available, otherwise we use a
  // plain `interfaces.set` through TypeScript's structural typing.
  (engine as unknown as { interfaces: Map<string, OSPFInterface> }).interfaces.set(name, iface);
  return iface;
}

function makeRouterLSA(routerId: string): LSA {
  return {
    lsAge: 0,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter: routerId,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 24,
    flags: 0,
    numLinks: 0,
    links: [],
  } as LSA;
}

describe('OSPFEngine reactive primitives', () => {
  let bus: EventBus;
  let scheduler: VirtualTimeScheduler;
  let engine: OSPFEngine;
  let trace: DomainEvent[];

  beforeEach(() => {
    ({ engine, bus, scheduler, trace } = buildEngine('1.1.1.1'));
  });

  it('does not allocate any native timer when start() is called', () => {
    engine.start();
    // The LSA aging interval is the only timer registered at start().
    expect(scheduler.pendingCount()).toBe(1);
  });

  it('drives the LSA aging timer through the injected scheduler', () => {
    // Install one LSA to age.
    const lsa = makeRouterLSA('1.1.1.1');
    lsa.lsAge = 10;
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    engine.start();
    scheduler.advance(5_000); // 5 ticks
    expect(lsa.lsAge).toBe(15);
  });

  it('emits ospf.lsa.installed when a new LSA enters the LSDB', () => {
    const lsa = makeRouterLSA('2.2.2.2');
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    const installed = trace.find((e) => e.topic === 'ospf.lsa.installed');
    expect(installed).toBeDefined();
    expect(
      (installed as DomainEvent & { topic: 'ospf.lsa.installed' }).payload.areaId,
    ).toBe(OSPF_BACKBONE_AREA);
  });

  it('emits ospf.lsa.flushed with reason=maxage when an LSA reaches MaxAge', () => {
    const lsa = makeRouterLSA('2.2.2.2');
    lsa.lsAge = OSPF_MAX_AGE - 2;
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    engine.start();
    // 3 ticks → 1 above MaxAge → purge happens.
    scheduler.advance(3_000);

    const flushed = trace.find((e) => e.topic === 'ospf.lsa.flushed');
    expect(flushed).toBeDefined();
    expect(
      (flushed as DomainEvent & { topic: 'ospf.lsa.flushed' }).payload.reason,
    ).toBe('maxage');
  });

  it('refreshes self-originated LSAs at LS_REFRESH_TIME (no flush)', () => {
    const lsa = makeRouterLSA('1.1.1.1'); // self
    lsa.lsAge = OSPF_LS_REFRESH_TIME - 1;
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    engine.start();
    scheduler.advance(2_000); // crosses LS_REFRESH_TIME

    // Should NOT be flushed — only refreshed (lsAge reset to 0 then re-aged).
    expect(trace.find((e) => e.topic === 'ospf.lsa.flushed')).toBeUndefined();
    expect(lsa.lsAge).toBeLessThan(10);
  });

  it('emits ospf.spf.run + ospf.routes-recomputed when SPF runs', () => {
    engine.start();
    engine.runSPF();

    const spf = trace.find((e) => e.topic === 'ospf.spf.run');
    const recomputed = trace.find((e) => e.topic === 'ospf.routes-recomputed');
    expect(spf).toBeDefined();
    expect(recomputed).toBeDefined();
    expect(
      (spf as DomainEvent & { topic: 'ospf.spf.run' }).payload.kind,
    ).toBe('full');
    expect(
      (spf as DomainEvent & { topic: 'ospf.spf.run' }).payload.routerId,
    ).toBe('1.1.1.1');
  });

  it('emits ospf.area.activated for every configured area on start()', () => {
    // Add a second area.
    engine.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    trace.length = 0;

    engine.start();

    const activations = trace.filter((e) => e.topic === 'ospf.area.activated');
    const ids = activations.map(
      (e) => (e as DomainEvent & { topic: 'ospf.area.activated' }).payload.areaId,
    );
    expect(new Set(ids)).toEqual(new Set(['0.0.0.0', '0.0.0.1']));
  });

  it('exposes a runtime signal that updates after start() and runSPF()', () => {
    const initial = engine.observables.runtime.get();
    expect(initial.running).toBe(false);
    expect(initial.spfRuns).toBe(0);

    engine.start();
    const afterStart = engine.observables.runtime.get();
    expect(afterStart.running).toBe(true);

    engine.runSPF();
    const afterSpf = engine.observables.runtime.get();
    expect(afterSpf.spfRuns).toBe(1);
    expect(afterSpf.lastSpfKind).toBe('full');
  });

  it('exposes a routes signal that mirrors getRouteTable() after SPF', () => {
    engine.start();
    const routes = engine.runSPF();
    const observed = engine.observables.routes.get();
    expect(observed.routes.length).toBe(routes.length);
  });

  it('exposes an LSDB summary signal that updates on installLSA', () => {
    expect(engine.observables.lsdbSummary.get().totalLSAs).toBe(0);
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    expect(engine.observables.lsdbSummary.get().totalLSAs).toBe(1);
    expect(engine.observables.lsdbSummary.get().headers).toHaveLength(1);
  });

  it('shutdown() clears every scheduler timer (no leak)', () => {
    engine.start();
    expect(scheduler.pendingCount()).toBe(1);

    engine.stop();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('emits ospf.dr-election with the elected DR/BDR pair', () => {
    const iface = attachIface(engine, 'eth0', '10.0.0.1');
    iface.networkType = 'broadcast';
    iface.priority = 5;
    iface.state = 'Waiting';
    trace.length = 0;

    engine.drElection(iface);

    const elected = trace.find((e) => e.topic === 'ospf.dr-election');
    expect(elected).toBeDefined();
    const payload = (elected as DomainEvent & { topic: 'ospf.dr-election' }).payload;
    expect(payload.iface).toBe('eth0');
    expect(payload.dr).toBe('10.0.0.1');
  });

  it('runtime signal subscribes notify on every SPF run', () => {
    let calls = 0;
    engine.observables.runtime.subscribe(() => calls++);

    engine.start();
    const baseline = calls;
    engine.runSPF();
    engine.runSPF();
    expect(calls - baseline).toBeGreaterThanOrEqual(2);
  });
});
