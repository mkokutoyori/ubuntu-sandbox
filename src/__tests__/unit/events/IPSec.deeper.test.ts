/**
 * Phase 4b2-IPSec.deeper — full reactive uplift.
 *
 * Verifies:
 *   - the full IPSec event taxonomy (engine started/stopped, SA
 *     installed/deleted, inbound/outbound chain outcomes);
 *   - the IPSecObservables surface (ikeSAs, ipsecSAs, fragGroups,
 *     stats) is refreshed reactively by IPSecSignalRefreshActor;
 *   - the OutboundFilterChain runs the default 4-step pipeline,
 *     supports plug-ins, and emits its outcome on the bus;
 *   - cross-engine isolation via deviceId filter;
 *   - SA emissions on install (via fake direct engine API) and on
 *     clearSAsForPeer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPSecEngine, type IPSecOutboundContext, type IPSecInboundContext } from '@/network/ipsec/IPSecEngine';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { Continue, Drop, Reject, makeFilter } from '@/network/core/FilterChain';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { DomainEvent } from '@/events/types';
import type { IKE_SA, IPSec_SA } from '@/network/ipsec/IPSecTypes';

function buildEngine(): {
  router: CiscoRouter;
  engine: IPSecEngine;
  bus: EventBus;
  scheduler: VirtualTimeScheduler;
  trace: DomainEvent[];
} {
  EquipmentRegistry.resetInstance();
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));
  const router = new CiscoRouter('R1');
  const engine = new IPSecEngine(router);
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  return { router, engine, bus, scheduler, trace };
}

const sampleIn: IPSecInboundContext = {
  spi: 0x100,
  seqNum: 42,
  payloadLen: 1280,
  fromIp: '10.0.0.2',
  toIp: '10.0.0.1',
  mode: 'tunnel',
};

const sampleOut: IPSecOutboundContext = {
  fromIp: '10.0.0.1',
  toIp: '10.0.0.2',
  innerProtocol: 6,
  payloadLen: 1280,
  spdVerdict: 'protect',
  outboundSpi: 0x200,
};

describe('IPSecEngine — engine lifecycle events', () => {
  it('emits ipsec.engine.started on start()', () => {
    const { engine, trace } = buildEngine();
    engine.start();
    const started = trace.find((e) => e.topic === 'ipsec.engine.started');
    expect(started).toBeDefined();
    expect(
      (started as DomainEvent & { topic: 'ipsec.engine.started' }).payload.deviceId,
    ).toBeDefined();
  });

  it('emits ipsec.engine.stopped on stop()', () => {
    const { engine, trace } = buildEngine();
    engine.start();
    trace.length = 0;
    engine.stop();
    const stopped = trace.find((e) => e.topic === 'ipsec.engine.stopped');
    expect(stopped).toBeDefined();
  });
});

describe('IPSecEngine — full observables surface', () => {
  it('exposes ikeSAs / ipsecSAs / fragGroups / stats signals', () => {
    const { engine } = buildEngine();
    expect(engine.observables.ikeSAs.get()).toEqual([]);
    expect(engine.observables.ipsecSAs.get()).toEqual([]);
    expect(engine.observables.fragGroups.get()).toEqual([]);
    expect(engine.observables.stats.get().running).toBe(false);
  });

  it('signals are refreshed reactively when SAs are installed', () => {
    const { engine, router } = buildEngine();
    engine.start();

    // Inject a synthetic IKE SA into the DB and emit the event the
    // SignalRefreshActor reacts to.
    const fakeIkeSA: IKE_SA = {
      peerIP: '10.0.0.2',
      localIP: '10.0.0.1',
      status: 'QM_IDLE',
      created: Date.now(),
      lifetime: 86400,
      authMethod: 'pre-share',
      encryption: 'aes',
      hash: 'sha',
      group: 'group2',
      lifetimeKB: 0,
      spiInitiator: 1,
      spiResponder: 2,
      iv: '',
      cookie: '',
      messageId: 0,
      dpdEnabled: false,
      dpdTimeouts: 0,
    } as IKE_SA;
    (engine as unknown as { ikeSADB: Map<string, IKE_SA> }).ikeSADB.set('10.0.0.2', fakeIkeSA);

    // Manually publish the install event (in production this is done
    // by the engine itself in processInboundIKE; here we test the
    // reactive flow in isolation).
    const bus = (engine as unknown as { getBus(): EventBus }).getBus();
    bus.publish({
      topic: 'ipsec.ike.sa-installed',
      payload: {
        deviceId: router.id,
        peerIp: '10.0.0.2',
        localIp: '10.0.0.1',
        version: 1,
        lifetimeSec: 86400,
      },
    });

    expect(engine.observables.ikeSAs.get()).toHaveLength(1);
    expect(engine.observables.ikeSAs.get()[0].peerIp).toBe('10.0.0.2');
  });

  it('clearSAsForPeer emits ipsec.sa-deleted + ipsec.ike.sa-deleted', () => {
    const { engine, router, trace } = buildEngine();
    engine.start();

    // Seed an IKE SA and an IPSec SA for peer 10.0.0.2.
    const fakeIkeSA: IKE_SA = {
      peerIP: '10.0.0.2',
      localIP: '10.0.0.1',
      status: 'QM_IDLE',
      created: Date.now(),
      lifetime: 86400,
    } as IKE_SA;
    (engine as unknown as { ikeSADB: Map<string, IKE_SA> }).ikeSADB.set('10.0.0.2', fakeIkeSA);

    const fakeIpsecSA = {
      peerIP: '10.0.0.2',
      spiIn: 0x100,
      spiOut: 0x200,
      protocol: 'ESP',
      mode: 'tunnel',
    } as unknown as IPSec_SA;
    (engine as unknown as { ipsecSADB: Map<string, IPSec_SA[]> }).ipsecSADB.set('10.0.0.2', [fakeIpsecSA]);
    (engine as unknown as { spiToSA: Map<number, IPSec_SA> }).spiToSA.set(0x100, fakeIpsecSA);

    trace.length = 0;
    engine.clearSAsForPeer('10.0.0.2', 'manual');

    expect(trace.find((e) => e.topic === 'ipsec.ike.sa-deleted')).toBeDefined();
    expect(trace.find((e) => e.topic === 'ipsec.sa.deleted')).toBeDefined();
    void router;
  });

  it('runtime stats counters are updated by chain outcomes', () => {
    const { engine } = buildEngine();
    engine.runInboundChain(sampleIn);
    engine.runInboundChain({ ...sampleIn, seqNum: 0 }); // rejected
    engine.runOutboundChain(sampleOut);
    engine.runOutboundChain({ ...sampleOut, payloadLen: 0 }); // dropped

    const stats = engine.observables.stats.get();
    expect(stats.inboundProcessed).toBe(1);
    expect(stats.inboundRejected).toBe(1);
    expect(stats.outboundProcessed).toBe(1);
    expect(stats.outboundDropped).toBe(1);
  });
});

describe('IPSecEngine — outbound FilterChain', () => {
  it('exposes the default 4-step outbound chain', () => {
    const { engine } = buildEngine();
    expect(engine.outboundChain.names()).toEqual([
      'spd-lookup',
      'sa-select',
      'fragmentation',
      'encap-audit',
    ]);
  });

  it('a normal egress packet is accepted', () => {
    const { engine } = buildEngine();
    const outcome = engine.runOutboundChain(sampleOut);
    expect(outcome.verdict).toBe('accepted');
    expect(outcome.decidedBy).toBe('encap-audit');
  });

  it('SPD discard verdict drops at spd-lookup', () => {
    const { engine } = buildEngine();
    const outcome = engine.runOutboundChain({ ...sampleOut, spdVerdict: 'discard' });
    expect(outcome.verdict).toBe('dropped');
    expect(outcome.decidedBy).toBe('spd-lookup');
  });

  it('SPD protect without an SA → rejected at sa-select', () => {
    const { engine } = buildEngine();
    const outcome = engine.runOutboundChain({
      ...sampleOut,
      spdVerdict: 'protect',
      outboundSpi: undefined,
    });
    expect(outcome.verdict).toBe('rejected');
    expect(outcome.code).toBe('NO_SA');
  });

  it('empty payload drops at fragmentation', () => {
    const { engine } = buildEngine();
    const outcome = engine.runOutboundChain({ ...sampleOut, payloadLen: 0 });
    expect(outcome.verdict).toBe('dropped');
    expect(outcome.decidedBy).toBe('fragmentation');
  });

  it('a custom QoS-classifier filter slots in via addAfter()', () => {
    const { engine } = buildEngine();
    let qosClassifications = 0;
    engine.outboundChain.addAfter(
      'spd-lookup',
      makeFilter<IPSecOutboundContext>('qos-classifier', (ctx) => {
        qosClassifications++;
        return Continue();
      }),
    );

    engine.runOutboundChain(sampleOut);
    expect(qosClassifications).toBe(1);
    expect(engine.outboundChain.names()).toEqual([
      'spd-lookup',
      'qos-classifier',
      'sa-select',
      'fragmentation',
      'encap-audit',
    ]);
  });

  it('emits ipsec.outbound.outcome on each run', () => {
    const { engine, trace } = buildEngine();
    engine.runOutboundChain(sampleOut);
    const outcome = trace.find((e) => e.topic === 'ipsec.outbound.outcome');
    expect(outcome).toBeDefined();
    expect(
      (outcome as DomainEvent & { topic: 'ipsec.outbound.outcome' }).payload.outcome,
    ).toBe('accepted');
  });
});

describe('IPSecEngine — inbound chain emits ipsec.inbound.outcome', () => {
  it('emits the typed outcome event after each chain run', () => {
    const { engine, trace } = buildEngine();
    engine.runInboundChain(sampleIn);
    engine.runInboundChain({ ...sampleIn, seqNum: 0 });

    const outcomes = trace.filter((e) => e.topic === 'ipsec.inbound.outcome');
    expect(outcomes).toHaveLength(2);
    expect(
      (outcomes[0] as DomainEvent & { topic: 'ipsec.inbound.outcome' }).payload.outcome,
    ).toBe('accepted');
    expect(
      (outcomes[1] as DomainEvent & { topic: 'ipsec.inbound.outcome' }).payload.outcome,
    ).toBe('rejected');
  });
});

describe('IPSec — cross-engine deviceId filtering', () => {
  it('two engines on the same bus do not pollute each other signals', () => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const e1 = new IPSecEngine(r1);
    const e2 = new IPSecEngine(r2);
    e1.setEventBus(bus);
    e2.setEventBus(bus);
    e1.start();
    e2.start();

    e1.runInboundChain(sampleIn);
    e1.runInboundChain(sampleIn);
    e2.runInboundChain(sampleIn);

    expect(e1.observables.stats.get().inboundProcessed).toBe(2);
    expect(e2.observables.stats.get().inboundProcessed).toBe(1);
  });
});
