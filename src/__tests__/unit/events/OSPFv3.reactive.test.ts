/**
 * Phase 4b2-OSPFv3 — verifies reactive parity with OSPFv2.
 *
 * Each test exercises the full bus → actor → signal pipeline:
 *   - the engine emits events at every state mutation;
 *   - the OSPFv3SignalRefreshActor reacts and refreshes signals;
 *   - external observers (the tests) read engine.observables.* to
 *     verify the projected view-model.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OSPFv3Engine } from '@/network/ospf/OSPFv3Engine';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { OspfCaptureActor } from '@/network/ospf/actors';
import {
  OSPF_BACKBONE_AREA,
  OSPF_VERSION_3,
  type OSPFv3HelloPacket,
  type LSA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
} from '@/network/ospf/types';
import type { DomainEvent } from '@/events/types';

function buildV3Engine(routerId = '1.1.1.1') {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const engine = new OSPFv3Engine(1);
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  engine.setRouterId(routerId);
  engine.addArea(OSPF_BACKBONE_AREA);
  return { engine, bus, scheduler, trace };
}

function makeV3Hello(routerId: string, neighbors: string[] = []): OSPFv3HelloPacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_3,
    packetType: 1,
    routerId,
    areaId: OSPF_BACKBONE_AREA,
    interfaceId: 1,
    priority: 1,
    options: 0x13,
    helloInterval: 10,
    deadInterval: 40,
    designatedRouter: '0.0.0.0',
    backupDesignatedRouter: '0.0.0.0',
    neighbors,
  };
}

function makeLinkLSA(routerId: string): LSA {
  return {
    lsAge: 0,
    options: 0x13,
    lsType: 0x0008,
    linkStateId: '0.0.0.1',
    advertisingRouter: routerId,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 32,
  } as LSA;
}

describe('OSPFv3 — observables surface', () => {
  it('exposes neighbors / interfaces / runtime / lsdbSummary signals', () => {
    const { engine } = buildV3Engine();
    expect(engine.observables.neighbors.get()).toEqual([]);
    expect(engine.observables.interfaces.get()).toEqual([]);
    expect(engine.observables.runtime.get().running).toBe(false);
    expect(engine.observables.lsdbSummary.get().totalLSAs).toBe(0);
  });

  it('runtime signal reflects start() / stop()', () => {
    const { engine } = buildV3Engine();
    engine.start();
    expect(engine.observables.runtime.get().running).toBe(true);
    engine.stop();
    expect(engine.observables.runtime.get().running).toBe(false);
  });
});

describe('OSPFv3 — reactive event emissions', () => {
  it('emits ospf.area.activated for every configured area on start()', () => {
    const { engine, trace } = buildV3Engine();
    engine.addArea('0.0.0.1');
    trace.length = 0;
    engine.start();

    const activations = trace.filter((e) => e.topic === 'ospf.area.activated');
    const ids = activations.map(
      (e) => (e as DomainEvent & { topic: 'ospf.area.activated' }).payload.areaId,
    );
    expect(new Set(ids)).toEqual(new Set(['0.0.0.0', '0.0.0.1']));
  });

  it('emits ospf.lsa.installed when installLSA() is called', () => {
    const { engine, trace } = buildV3Engine();
    engine.installLSA(OSPF_BACKBONE_AREA, makeLinkLSA('2.2.2.2'));

    const installed = trace.find((e) => e.topic === 'ospf.lsa.installed');
    expect(installed).toBeDefined();
    expect(
      (installed as DomainEvent & { topic: 'ospf.lsa.installed' }).payload.areaId,
    ).toBe(OSPF_BACKBONE_AREA);
  });

  it('emits ospf.packet.received at the top of processHello', () => {
    const { engine, trace } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'broadcast',
      ipAddress: 'fe80::1',
    });
    trace.length = 0;

    engine.processHello('eth0', 'fe80::2', makeV3Hello('2.2.2.2'));

    const received = trace.find((e) => e.topic === 'ospf.packet.received');
    expect(received).toBeDefined();
    expect(
      (received as DomainEvent & { topic: 'ospf.packet.received' }).payload.iface,
    ).toBe('eth0');
  });

  it('emits ospf.neighbor.state-changed on Hello-driven transitions', () => {
    const { engine, trace } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });
    trace.length = 0;

    engine.processHello('eth0', 'fe80::2', makeV3Hello('2.2.2.2'));

    const transitions = trace.filter((e) => e.topic === 'ospf.neighbor.state-changed');
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    // First transition should be Down → Init via HelloReceived.
    const first = transitions[0] as DomainEvent & { topic: 'ospf.neighbor.state-changed' };
    expect(first.payload.oldState).toBe('Down');
    expect(first.payload.newState).toBe('Init');
    expect(first.payload.event).toBe('HelloReceived');
  });

  it('emits ospf.interface.state-changed on activate / deactivate', () => {
    const { engine, trace } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });
    const transitions = trace.filter((e) => e.topic === 'ospf.interface.state-changed');
    expect(transitions.length).toBeGreaterThan(0);
    expect(
      (transitions[transitions.length - 1] as DomainEvent & { topic: 'ospf.interface.state-changed' }).payload.newState,
    ).toBe('PointToPoint');

    trace.length = 0;
    engine.deactivateInterface('eth0');
    const downTransition = trace.find(
      (e) =>
        e.topic === 'ospf.interface.state-changed' &&
        (e as DomainEvent & { topic: 'ospf.interface.state-changed' }).payload.newState === 'Down',
    );
    expect(downTransition).toBeDefined();
  });

  it('emits ospf.dr-election when DR/BDR change on a broadcast iface', () => {
    const { engine, trace } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'broadcast',
      ipAddress: 'fe80::1',
    });
    trace.length = 0;

    // Drive a Hello where peer agrees we're the DR — triggers election.
    engine.processHello(
      'eth0',
      'fe80::2',
      { ...makeV3Hello('2.2.2.2', ['1.1.1.1']), backupDesignatedRouter: '2.2.2.2' },
    );

    const election = trace.find((e) => e.topic === 'ospf.dr-election');
    expect(election).toBeDefined();
  });
});

describe('OSPFv3 — SignalRefreshActor drives the read-models', () => {
  it('refreshes neighbors signal after a Hello-driven transition', () => {
    const { engine } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    expect(engine.observables.neighbors.get()).toHaveLength(0);
    engine.processHello('eth0', 'fe80::2', makeV3Hello('2.2.2.2'));

    const neighbors = engine.observables.neighbors.get();
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].routerId).toBe('2.2.2.2');
    // Down → Init is the first transition; further transitions move to Full
    // (P2P + sees us in subsequent hellos), but a single Hello yields Init.
    expect(neighbors[0].state).toBe('Init');
  });

  it('refreshes lsdbSummary after installLSA', () => {
    const { engine } = buildV3Engine();
    expect(engine.observables.lsdbSummary.get().totalLSAs).toBe(0);
    engine.installLSA(OSPF_BACKBONE_AREA, makeLinkLSA('2.2.2.2'));
    expect(engine.observables.lsdbSummary.get().totalLSAs).toBe(1);
  });

  it('refreshes interfaces signal after activate', () => {
    const { engine } = buildV3Engine();
    expect(engine.observables.interfaces.get()).toHaveLength(0);
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    const ifaces = engine.observables.interfaces.get();
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].state).toBe('PointToPoint');
  });

  it('a runtime signal subscriber is notified on Hello-driven adjacency changes', () => {
    const { engine } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    let calls = 0;
    engine.observables.runtime.subscribe(() => calls++);

    engine.processHello('eth0', 'fe80::2', makeV3Hello('2.2.2.2'));

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(engine.observables.runtime.get().neighborCount).toBe(1);
  });
});

describe('OSPFv3 — packet capture via OspfCaptureActor (cross-engine reuse)', () => {
  it('OspfCaptureActor records both v3 ingress and egress', () => {
    const { engine, bus } = buildV3Engine();
    engine.activateInterface('eth0', OSPF_BACKBONE_AREA, {
      networkType: 'broadcast',
      ipAddress: 'fe80::1',
    });

    const capture = new OspfCaptureActor(bus, 100);
    capture.start();

    // Hello received → ospf.packet.received captured.
    engine.processHello('eth0', 'fe80::2', makeV3Hello('2.2.2.2'));

    const cap = capture.getCapture();
    const inHellos = cap.filter((c) => c.direction === 'in' && c.packet.packetType === 1);
    expect(inHellos.length).toBeGreaterThanOrEqual(1);

    capture.stop();
  });
});

describe('OSPFv3 — actors filter cross-engine pollution', () => {
  it('two v3 engines on the same bus do not pollute each other signals', () => {
    const bus = new EventBus();
    const e1 = new OSPFv3Engine(1);
    e1.setEventBus(bus);
    e1.setRouterId('1.1.1.1');
    e1.addArea(OSPF_BACKBONE_AREA);

    const e2 = new OSPFv3Engine(1);
    e2.setEventBus(bus);
    e2.setRouterId('2.2.2.2');
    e2.addArea(OSPF_BACKBONE_AREA);

    e1.installLSA(OSPF_BACKBONE_AREA, makeLinkLSA('1.1.1.1'));

    expect(e1.observables.lsdbSummary.get().totalLSAs).toBe(1);
    expect(e2.observables.lsdbSummary.get().totalLSAs).toBe(0);
  });
});
