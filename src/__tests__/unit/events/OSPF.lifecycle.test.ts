/**
 * Phase 4b2-OSPF.lifecycle — Hello + DD/LSR retransmits as reactive actors.
 *
 * Verifies that:
 *   - the per-interface Hello timer emits `ospf.hello.send-requested`
 *     instead of calling sendHello directly, and the bundled
 *     HelloActor performs the actual send;
 *   - the DD/LSR retransmit timers emit `ospf.dd.retransmit-due` /
 *     `ospf.lsr.retransmit-due`, which the bundled RetransmitActor
 *     translates into the corresponding resend;
 *   - both flows survive a setEventBus rebind.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  OSPF_BACKBONE_AREA,
  OSPF_VERSION_2,
  type OSPFInterface,
  type OSPFHelloPacket,
  type OSPFDDPacket,
  DD_FLAG_INIT,
  DD_FLAG_MORE,
  DD_FLAG_MASTER,
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

function attachIface(engine: OSPFEngine, ipAddress: string): OSPFInterface {
  const iface: OSPFInterface = {
    name: 'eth0',
    areaId: OSPF_BACKBONE_AREA,
    ipAddress,
    mask: '255.255.255.0',
    networkType: 'point-to-point',
    state: 'PointToPoint',
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

describe('HelloActor — Hello protocol via bus event', () => {
  it('the engine emits ospf.hello.send-requested instead of sending directly', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');
    const iface = attachIface(engine, '10.0.0.1');
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    // Drive a Hello-timer cycle by calling startHelloTimer indirectly
    // via interfaceUp on the engine's private path.
    (engine as unknown as { startHelloTimer(i: OSPFInterface): void }).startHelloTimer(iface);

    // Initial Hello: the engine immediately emits send-requested.
    const initialRequests = trace.filter((e) => e.topic === 'ospf.hello.send-requested');
    expect(initialRequests).toHaveLength(1);

    // The HelloActor reacts and sends — sendCallback was called via
    // dispatchOutgoing once.
    expect(sendSpy).toHaveBeenCalled();

    // Advance past one helloInterval — another tick fires.
    scheduler.advance(10_000);
    const afterTickRequests = trace.filter((e) => e.topic === 'ospf.hello.send-requested');
    expect(afterTickRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('a custom subscriber can intercept hellos before the actor reacts', () => {
    const { engine, bus, trace } = buildEngine('1.1.1.1');
    const iface = attachIface(engine, '10.0.0.1');

    const intercepted: string[] = [];
    bus.subscribe('ospf.hello.send-requested', (e) => {
      intercepted.push(e.payload.iface);
    });

    (engine as unknown as { startHelloTimer(i: OSPFInterface): void }).startHelloTimer(iface);

    expect(intercepted).toContain('eth0');
  });

  it('disabling the HelloActor stops the actual send while the timer keeps emitting', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');
    const iface = attachIface(engine, '10.0.0.1');
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    // Stop the HelloActor — only the timer events remain on the bus.
    (engine as unknown as { helloActor: { stop(): void } }).helloActor.stop();

    (engine as unknown as { startHelloTimer(i: OSPFInterface): void }).startHelloTimer(iface);
    scheduler.advance(20_000);

    const tickEvents = trace.filter((e) => e.topic === 'ospf.hello.send-requested');
    expect(tickEvents.length).toBeGreaterThan(0);
    // No actual send because the actor is stopped.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('engine.sendHelloOnInterface is the actor-API entry point', () => {
    const { engine } = buildEngine('1.1.1.1');
    const iface = attachIface(engine, '10.0.0.1');
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    // Direct call (e.g. for tests / replay).
    engine.sendHelloOnInterface('eth0');
    expect(sendSpy).toHaveBeenCalled();
    void iface;
  });
});

describe('RetransmitActor — DD/LSR retransmits via bus event', () => {
  function buildEngineWithExStartNeighbor() {
    const ctx = buildEngine('1.1.1.1');
    const iface = attachIface(ctx.engine, '10.0.0.1');

    const lastSentDD: OSPFDDPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 2,
      routerId: '1.1.1.1',
      areaId: OSPF_BACKBONE_AREA,
      interfaceMTU: 1500,
      options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 1234,
      lsaHeaders: [],
    };

    iface.neighbors.set('2.2.2.2', {
      routerId: '2.2.2.2',
      ipAddress: '10.0.0.2',
      iface: 'eth0',
      state: 'ExStart',
      priority: 1,
      neighborDR: '0.0.0.0',
      neighborBDR: '0.0.0.0',
      deadTimer: null,
      ddSeqNumber: 1234,
      isMaster: true,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      lastHelloReceived: 0,
      options: 0x02,
      ddRetransmitTimer: null,
      lsrRetransmitTimer: null,
      lastSentDD,
    });

    return { ...ctx, iface };
  }

  it('startDDRetransmitTimer emits ospf.dd.retransmit-due after RxmtInterval', () => {
    const { engine, scheduler, trace, iface } = buildEngineWithExStartNeighbor();
    const neighbor = iface.neighbors.get('2.2.2.2')!;

    (engine as unknown as {
      startDDRetransmitTimer(i: OSPFInterface, n: typeof neighbor): void;
    }).startDDRetransmitTimer(iface, neighbor);

    expect(trace.find((e) => e.topic === 'ospf.dd.retransmit-due')).toBeUndefined();
    scheduler.advance(5_000);
    const due = trace.find((e) => e.topic === 'ospf.dd.retransmit-due');
    expect(due).toBeDefined();
    expect(
      (due as DomainEvent & { topic: 'ospf.dd.retransmit-due' }).payload.neighborId,
    ).toBe('2.2.2.2');
  });

  it('the actor resends the DD via dispatchOutgoing when the event fires', () => {
    const { engine, scheduler, trace, iface } = buildEngineWithExStartNeighbor();
    const neighbor = iface.neighbors.get('2.2.2.2')!;
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    (engine as unknown as {
      startDDRetransmitTimer(i: OSPFInterface, n: typeof neighbor): void;
    }).startDDRetransmitTimer(iface, neighbor);

    scheduler.advance(5_000);
    expect(sendSpy).toHaveBeenCalled();

    // Causal order: due event arrives BEFORE packet.outgoing.
    const idxDue = trace.findIndex((e) => e.topic === 'ospf.dd.retransmit-due');
    const idxOut = trace.findIndex((e) => e.topic === 'ospf.packet.outgoing');
    expect(idxDue).toBeGreaterThanOrEqual(0);
    expect(idxOut).toBeGreaterThanOrEqual(0);
    expect(idxDue).toBeLessThan(idxOut);
  });

  it('stopping the RetransmitActor halts further DD retransmissions', () => {
    const { engine, scheduler, iface } = buildEngineWithExStartNeighbor();
    const neighbor = iface.neighbors.get('2.2.2.2')!;
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    (engine as unknown as { retransmitActor: { stop(): void } }).retransmitActor.stop();
    (engine as unknown as {
      startDDRetransmitTimer(i: OSPFInterface, n: typeof neighbor): void;
    }).startDDRetransmitTimer(iface, neighbor);

    scheduler.advance(5_000);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('LSR retransmit timer publishes ospf.lsr.retransmit-due', () => {
    const { engine, scheduler, trace } = buildEngine('1.1.1.1');
    const iface = attachIface(engine, '10.0.0.1');

    const neighbor = {
      routerId: '2.2.2.2',
      ipAddress: '10.0.0.2',
      iface: 'eth0',
      state: 'Loading' as const,
      priority: 1,
      neighborDR: '0.0.0.0',
      neighborBDR: '0.0.0.0',
      deadTimer: null,
      ddSeqNumber: 0,
      isMaster: false,
      lsRequestList: [
        { lsType: 1, linkStateId: '3.3.3.3', advertisingRouter: '3.3.3.3' },
      ],
      lsRetransmissionList: [],
      dbSummaryList: [],
      lastHelloReceived: 0,
      options: 0x02,
      ddRetransmitTimer: null,
      lsrRetransmitTimer: null,
      lastSentDD: null,
    };
    iface.neighbors.set('2.2.2.2', neighbor as never);

    (engine as unknown as {
      startLSRRetransmitTimer(i: OSPFInterface, n: typeof neighbor): void;
    }).startLSRRetransmitTimer(iface, neighbor);

    scheduler.advance(5_000);
    const due = trace.find((e) => e.topic === 'ospf.lsr.retransmit-due');
    expect(due).toBeDefined();
  });
});

describe('Lifecycle actors survive setEventBus()', () => {
  it('after rebinding the bus, Hello timer still emits on the new bus and HelloActor still reacts', () => {
    const { engine } = buildEngine('1.1.1.1');
    const newBus = new EventBus();
    const trace: DomainEvent[] = [];
    newBus.subscribeAll((e) => trace.push(e));

    engine.setEventBus(newBus);
    const iface = attachIface(engine, '10.0.0.1');
    const sendSpy = vi.fn();
    engine.setSendCallback(sendSpy);

    (engine as unknown as { startHelloTimer(i: OSPFInterface): void }).startHelloTimer(iface);

    expect(trace.find((e) => e.topic === 'ospf.hello.send-requested')).toBeDefined();
    expect(sendSpy).toHaveBeenCalled();
  });
});
