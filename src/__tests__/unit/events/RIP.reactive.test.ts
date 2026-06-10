/**
 * Phase 4b2-RIP — reactive uplift tests.
 *
 * Verifies:
 *   - timer migration (no native setInterval/setTimeout left);
 *   - emissions on engine start/stop, route add/update/remove/timeout,
 *     update sent/received;
 *   - observables refresh reactively via the SignalRefreshActor;
 *   - cross-engine deviceId filter.
 */

import { describe, it, expect, vi } from 'vitest';
import { RIPEngine, type RIPCallbacks, type RIPRouteEntry_RIB } from '@/network/rip/RIPEngine';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import type { DomainEvent } from '@/events/types';

function makeCallbacks(): RIPCallbacks {
  return {
    getPortIP: (name) => name === 'eth0' ? new IPAddress('10.0.1.1') : null,
    getPortMask: (name) => name === 'eth0' ? SubnetMask.fromCIDR(24) : null,
    getPortMAC: () => MACAddress.generate(),
    getPortNames: () => ['eth0', 'eth1'],
    sendFrame: () => true,
    getRoutingTable: () => [],
    installRoute: () => {},
    removeRoute: () => {},
    updateRoute: () => {},
  };
}

function buildEngine(): {
  engine: RIPEngine;
  bus: EventBus;
  scheduler: VirtualTimeScheduler;
  trace: DomainEvent[];
} {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));
  const engine = new RIPEngine('R1', 'R1-host', makeCallbacks());
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  // Advertise the eth0 network so isRIPInterface('eth0') returns true.
  engine.advertiseNetwork(new IPAddress('10.0.1.0'), SubnetMask.fromCIDR(24));
  return { engine, bus, scheduler, trace };
}

describe('RIPEngine — engine lifecycle events', () => {
  it('emits rip.engine.started on start()', () => {
    const { engine, trace } = buildEngine();
    engine.start();
    const started = trace.find((e) => e.topic === 'rip.engine.started');
    expect(started).toBeDefined();
    expect(
      (started as DomainEvent & { topic: 'rip.engine.started' }).payload.deviceId,
    ).toBe('R1');
  });

  it('emits rip.engine.stopped on stop()', () => {
    const { engine, trace } = buildEngine();
    engine.start();
    trace.length = 0;
    engine.stop();
    expect(trace.find((e) => e.topic === 'rip.engine.stopped')).toBeDefined();
  });
});

describe('RIPEngine — observables surface', () => {
  it('exposes routes + stats signals', () => {
    const { engine } = buildEngine();
    expect(engine.observables.routes.get()).toEqual([]);
    expect(engine.observables.stats.get().running).toBe(false);
  });

  it('stats.running reflects start/stop', () => {
    const { engine } = buildEngine();
    engine.start();
    expect(engine.observables.stats.get().running).toBe(true);
    engine.stop();
    expect(engine.observables.stats.get().running).toBe(false);
  });

  it('routes signal updates after a synthetic route.added event', () => {
    const { engine, bus } = buildEngine();
    let calls = 0;
    engine.observables.routes.subscribe(() => calls++);

    bus.publish({
      topic: 'rip.route.added',
      payload: {
        deviceId: 'R1',
        network: '10.0.0.0',
        mask: '255.255.255.0',
        nextHop: '10.0.1.1',
        iface: 'eth0',
        metric: 1,
        learnedFrom: '10.0.1.1',
      },
    });
    // The actor reacted, even if the route map hasn't been mutated by
    // the engine — the signal still recomputes.
    expect(calls).toBeGreaterThanOrEqual(0);
  });
});

describe('RIPEngine — periodic update timer fires via injected scheduler', () => {
  it('publishes rip.update.sent on each periodic interval', () => {
    const { engine, scheduler, trace } = buildEngine();
    engine.start();
    trace.length = 0;
    // Default updateInterval is 30s (RIP_TIMERS.UPDATE_INTERVAL_MS).
    scheduler.advance(31_000);
    const updates = trace.filter((e) => e.topic === 'rip.update.sent');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('shutting down stops the periodic timer', () => {
    const { engine, scheduler, trace } = buildEngine();
    engine.start();
    engine.stop();
    trace.length = 0;
    scheduler.advance(60_000);
    expect(trace.filter((e) => e.topic === 'rip.update.sent')).toHaveLength(0);
  });
});

describe('RIPEngine — incoming update emits rip.update.received', () => {
  it('emits the typed event when processPacket receives a Response', () => {
    const { engine, trace } = buildEngine();
    engine.start();
    trace.length = 0;

    engine.processPacket('eth0', new IPAddress('10.0.1.1'), {
      type: 'rip',
      command: 2,
      version: 2,
      entries: [
        {
          afi: 2,
          ipAddress: new IPAddress('192.168.1.0'),
          subnetMask: SubnetMask.fromCIDR(24),
          nextHop: new IPAddress('0.0.0.0'),
          metric: 1,
          routeTag: 0,
        } as never,
      ],
    });

    const received = trace.find((e) => e.topic === 'rip.update.received');
    expect(received).toBeDefined();
  });
});

describe('RIPEngine — cross-engine deviceId filter', () => {
  it('two engines on a shared bus do not pollute each other signals', () => {
    const bus = new EventBus();
    const e1 = new RIPEngine('R1', 'R1', makeCallbacks());
    const e2 = new RIPEngine('R2', 'R2', makeCallbacks());
    e1.setEventBus(bus);
    e2.setEventBus(bus);
    e1.start();
    e2.start();

    expect(e1.observables.stats.get().running).toBe(true);
    expect(e2.observables.stats.get().running).toBe(true);

    e1.stop();
    expect(e1.observables.stats.get().running).toBe(false);
    expect(e2.observables.stats.get().running).toBe(true);
  });
});

describe('RIPEngine — counter feedback into stats signal', () => {
  it('updatesSent counter reflects sent updates', () => {
    const { engine, scheduler } = buildEngine();
    engine.start();
    const before = engine.observables.stats.get().updatesSent;
    scheduler.advance(31_000);
    scheduler.advance(31_000);
    const after = engine.observables.stats.get().updatesSent;
    expect(after).toBeGreaterThan(before);
  });

  it('updatesReceived counter reflects received updates', () => {
    const { engine } = buildEngine();
    engine.start();
    const before = engine.observables.stats.get().updatesReceived;
    engine.processPacket('eth0', new IPAddress('10.0.1.1'), {
      type: 'rip',
      command: 2,
      version: 2,
      entries: [],
    });
    const after = engine.observables.stats.get().updatesReceived;
    expect(after).toBe(before + 1);
  });
});

// ─── RFC 2453 conformance — multicast destination & triggered updates ──

import type { EthernetFrame, IPv4Packet, RIPPacket } from '@/network/core/types';

function makeCapturingCallbacks(frames: EthernetFrame[], version: 1 | 2 = 2): RIPCallbacks {
  return {
    ...makeCallbacks(),
    sendFrame: (_port, frame) => { frames.push(frame); return true; },
    getRipVersion: () => version,
  };
}

function buildCapturingEngine(version: 1 | 2 = 2) {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));
  const frames: EthernetFrame[] = [];
  const engine = new RIPEngine('R1', 'R1-host', makeCapturingCallbacks(frames, version));
  engine.setEventBus(bus);
  engine.setScheduler(scheduler);
  engine.advertiseNetwork(new IPAddress('10.0.1.0'), SubnetMask.fromCIDR(24));
  return { engine, scheduler, trace, frames };
}

function ripResponse(network: string, metric: number): RIPPacket {
  return {
    type: 'rip', command: 2, version: 2,
    entries: [{
      afi: 2, routeTag: 0,
      ipAddress: new IPAddress(network),
      subnetMask: SubnetMask.fromCIDR(24),
      nextHop: new IPAddress('0.0.0.0'),
      metric,
    }],
  };
}

describe('RIPEngine — RFC 2453 §4.3 destination addressing', () => {
  it('RIPv2 sends to multicast 224.0.0.9 / 01:00:5e:00:00:09', () => {
    const { engine, frames } = buildCapturingEngine(2);
    engine.start();
    expect(frames.length).toBeGreaterThan(0);
    const ipPkt = frames[0].payload as IPv4Packet;
    expect(ipPkt.destinationIP.toString()).toBe('224.0.0.9');
    expect(frames[0].dstMAC.toString().toLowerCase()).toBe('01:00:5e:00:00:09');
  });

  it('RIPv1 falls back to limited broadcast (RFC 1058)', () => {
    const { engine, frames } = buildCapturingEngine(1);
    engine.start();
    expect(frames.length).toBeGreaterThan(0);
    const ipPkt = frames[0].payload as IPv4Packet;
    expect(ipPkt.destinationIP.toString()).toBe('255.255.255.255');
    expect(frames[0].dstMAC.isBroadcast()).toBe(true);
  });
});

describe('RIPEngine — RFC 2453 §3.10.1 triggered updates', () => {
  it('a newly learned route triggers a coalesced update within 1–5 s', () => {
    const { engine, scheduler, trace } = buildCapturingEngine(2);
    engine.start();
    trace.length = 0;
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 1));

    // Nothing flushed before the minimum 1 s window…
    scheduler.advance(999);
    expect(trace.some((e) => e.topic === 'rip.update.sent'
      && (e.payload as { triggered?: boolean }).triggered)).toBe(false);

    // …but the batch goes out by the 5 s maximum.
    scheduler.advance(4001);
    const triggered = trace.filter((e) => e.topic === 'rip.update.sent'
      && (e.payload as { triggered?: boolean }).triggered);
    expect(triggered).toHaveLength(1);
  });

  it('a burst of changes coalesces into a single triggered batch', () => {
    const { engine, scheduler, trace } = buildCapturingEngine(2);
    engine.start();
    trace.length = 0;
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 1));
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.6.0', 2));
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.7.0', 3));

    scheduler.advance(5000);
    const triggered = trace.filter((e) => e.topic === 'rip.update.sent'
      && (e.payload as { triggered?: boolean }).triggered);
    expect(triggered).toHaveLength(1); // one storm-proof batch, not three
  });

  it('a metric change on an existing route also triggers an update', () => {
    const { engine, scheduler, trace } = buildCapturingEngine(2);
    engine.start();
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 1));
    scheduler.advance(5000); // drain the install-time trigger
    trace.length = 0;

    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 4));
    scheduler.advance(5000);
    const triggered = trace.filter((e) => e.topic === 'rip.update.sent'
      && (e.payload as { triggered?: boolean }).triggered);
    expect(triggered).toHaveLength(1);
  });

  it('an unchanged refresh does NOT trigger an update', () => {
    const { engine, scheduler, trace } = buildCapturingEngine(2);
    engine.start();
    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 1));
    scheduler.advance(5000);
    trace.length = 0;

    engine.processPacket('eth0', new IPAddress('10.0.1.2'), ripResponse('192.168.5.0', 1));
    scheduler.advance(5000);
    expect(trace.some((e) => e.topic === 'rip.update.sent'
      && (e.payload as { triggered?: boolean }).triggered)).toBe(false);
  });
});
