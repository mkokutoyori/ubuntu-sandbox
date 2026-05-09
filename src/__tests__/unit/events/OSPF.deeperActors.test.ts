/**
 * Phase 4b2-OSPF.deeper — verifies the second batch of bus actors.
 *
 *   - LsaRefreshActor: ospf.lsa.refresh-due → engine.refreshOwnLSA → ospf.lsa.refreshed
 *   - NetworkLsaActor: ospf.dr-election (we became DR) → originateNetworkLSA
 *   - RoutingTableSyncActor: ospf.routes-recomputed → install callbacks fire
 *
 * Plus a snapshot of the full causal chain for an LSA install.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA,
  OSPF_LS_REFRESH_TIME,
  type LSA,
  type OSPFInterface,
  type OSPFRouteEntry,
} from '@/network/ospf/types';
import type { DomainEvent } from '@/events/types';

function buildEngine(routerId = '1.1.1.1') {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const engine = new OSPFEngine(1);
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  engine.setRouterId(routerId);
  engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  return { engine, bus, scheduler, trace };
}

function makeRouterLSA(routerId: string, advertisingRouter = routerId): LSA {
  return {
    lsAge: 0,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 24,
    flags: 0,
    numLinks: 0,
    links: [],
  } as LSA;
}

describe('LsaRefreshActor — periodic refresh of self-originated LSAs', () => {
  it('reacts to ospf.lsa.refresh-due by calling refreshOwnLSA', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');

    // Install a self-originated LSA close to LS_REFRESH_TIME.
    const lsa = makeRouterLSA('1.1.1.1');
    lsa.lsAge = OSPF_LS_REFRESH_TIME - 1;
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    engine.start();
    trace.length = 0;

    // Advance just past LS_REFRESH_TIME — tickLSAge fires, emits
    // ospf.lsa.refresh-due, the actor refreshes the LSA, the engine
    // emits ospf.lsa.refreshed.
    scheduler.advance(2_000);

    const refreshDue = trace.find((e) => e.topic === 'ospf.lsa.refresh-due');
    const refreshed = trace.find((e) => e.topic === 'ospf.lsa.refreshed');
    expect(refreshDue).toBeDefined();
    expect(refreshed).toBeDefined();
    // The refresh resets lsAge to 0 — verify the engine state reflects this.
    expect(lsa.lsAge).toBeLessThan(5);
  });

  it('emits refresh-due BEFORE the engine performs the refresh', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');
    const lsa = makeRouterLSA('1.1.1.1');
    lsa.lsAge = OSPF_LS_REFRESH_TIME - 1;
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);
    engine.start();
    trace.length = 0;
    scheduler.advance(2_000);

    const idxDue = trace.findIndex((e) => e.topic === 'ospf.lsa.refresh-due');
    const idxRefreshed = trace.findIndex((e) => e.topic === 'ospf.lsa.refreshed');
    expect(idxDue).toBeGreaterThanOrEqual(0);
    expect(idxRefreshed).toBeGreaterThanOrEqual(0);
    expect(idxDue).toBeLessThan(idxRefreshed);
  });
});

describe('NetworkLsaActor — Network-LSA origination on becoming DR', () => {
  function attachIface(engine: OSPFEngine, ipAddress: string): OSPFInterface {
    const iface: OSPFInterface = {
      name: 'eth0',
      areaId: OSPF_BACKBONE_AREA,
      ipAddress,
      mask: '255.255.255.0',
      networkType: 'broadcast',
      state: 'Waiting',
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
    (engine as unknown as { interfaces: Map<string, OSPFInterface> }).interfaces.set('eth0', iface);
    return iface;
  }

  it('originates Network-LSA after a DR election where this engine wins', () => {
    const { engine } = buildEngine('1.1.1.1');
    attachIface(engine, '10.0.0.1');

    const spy = vi.spyOn(engine, 'originateNetworkLSA');

    // drElection() emits ospf.dr-election; the actor should react.
    engine.drElection(engine.getInterface('eth0')!);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('does NOT originate Network-LSA when this engine is not the DR', () => {
    const { engine, bus } = buildEngine('1.1.1.1');
    attachIface(engine, '10.0.0.1');

    const spy = vi.spyOn(engine, 'originateNetworkLSA');

    // Synthesise an election where DR is someone else.
    bus.publish({
      topic: 'ospf.dr-election',
      payload: {
        routerId: '1.1.1.1',
        processId: 1,
        iface: 'eth0',
        dr: '10.0.0.2', // not us
        bdr: '10.0.0.1',
      },
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('RoutingTableSyncActor — outbound install hook', () => {
  it('forwards routes to every registered installer on ospf.routes-recomputed', () => {
    const { engine } = buildEngine('1.1.1.1');
    const captured: ReadonlyArray<OSPFRouteEntry>[] = [];

    const unsub = engine.routingTableSync!.onRoutes((routes) => {
      captured.push([...routes]);
    });

    engine.start();
    engine.runSPF();

    expect(captured).toHaveLength(1);
    expect(Array.isArray(captured[0])).toBe(true);

    unsub();
    engine.runSPF();
    // After unsubscribing, no new captures.
    expect(captured).toHaveLength(1);
  });

  it('supports multiple installers concurrently', () => {
    const { engine } = buildEngine('1.1.1.1');
    let countA = 0;
    let countB = 0;
    engine.routingTableSync!.onRoutes(() => countA++);
    engine.routingTableSync!.onRoutes(() => countB++);

    engine.start();
    engine.runSPF();
    engine.runSPF();
    expect(countA).toBe(2);
    expect(countB).toBe(2);
    expect(engine.routingTableSync!.installerCount()).toBe(2);
  });

  it('does not break the chain when an installer throws', () => {
    const { engine } = buildEngine('1.1.1.1');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodInstaller = vi.fn();
    engine.routingTableSync!.onRoutes(() => { throw new Error('boom'); });
    engine.routingTableSync!.onRoutes(goodInstaller);

    engine.start();
    expect(() => engine.runSPF()).not.toThrow();
    expect(goodInstaller).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('preserves installers across setEventBus() rebinds', () => {
    const { engine } = buildEngine('1.1.1.1');
    let calls = 0;
    engine.routingTableSync!.onRoutes(() => calls++);

    const newBus = new EventBus();
    engine.setEventBus(newBus);
    expect(engine.routingTableSync!.installerCount()).toBe(1);

    engine.start();
    engine.runSPF();
    expect(calls).toBe(1);
  });
});

describe('Causal trace snapshot — install LSA → recomputed routes → installer fires', () => {
  it('records the full reactive chain in deterministic order', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');
    const installerCalls: number[] = [];
    engine.routingTableSync!.onRoutes(() => installerCalls.push(scheduler.now()));

    engine.start();
    trace.length = 0;
    installerCalls.length = 0;

    // The single user action: install a new Type 1 LSA.
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    scheduler.advance(5_000); // SPF debounce

    // Snapshot the topics in order — this is exactly what a §11.2.5
    // trace test would assert against a frozen reference.
    const topics = trace.map((e) => e.topic);

    // The chain must include these in this relative order:
    expect(topics).toContain('ospf.lsa.installed');
    expect(topics).toContain('ospf.spf.run');
    expect(topics).toContain('ospf.routes-recomputed');

    expect(topics.indexOf('ospf.lsa.installed'))
      .toBeLessThan(topics.indexOf('ospf.spf.run'));
    expect(topics.indexOf('ospf.spf.run'))
      .toBeLessThan(topics.indexOf('ospf.routes-recomputed'));

    // Installer was triggered after routes-recomputed.
    expect(installerCalls.length).toBeGreaterThan(0);
  });
});

describe('Pure projections — independent unit tests', () => {
  it('projectNeighbors handles an empty input without crashing', async () => {
    const { projectNeighbors } = await import('@/network/ospf/observables');
    expect(projectNeighbors([])).toEqual([]);
  });

  it('projectLsdbSummary returns zero counts on an empty LSDB', async () => {
    const { projectLsdbSummary } = await import('@/network/ospf/observables');
    const empty = { areas: new Map(), external: new Map() };
    const summary = projectLsdbSummary(empty);
    expect(summary.totalLSAs).toBe(0);
    expect(summary.externalCount).toBe(0);
    expect(summary.headers).toEqual([]);
  });

  it('lsaHeaderOf strips body fields and keeps only the header', async () => {
    const { lsaHeaderOf } = await import('@/network/ospf/observables');
    const lsa = makeRouterLSA('5.5.5.5');
    const header = lsaHeaderOf(lsa);
    expect(header.lsType).toBe(1);
    expect(header.linkStateId).toBe('5.5.5.5');
    expect((header as unknown as { numLinks?: number }).numLinks).toBeUndefined();
  });
});
