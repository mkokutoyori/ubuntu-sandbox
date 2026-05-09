/**
 * Phase 4b2-NAT — reactive uplift tests.
 *
 * Verifies:
 *   - NATEngine emits typed events for session lifecycle and TCP
 *     state transitions;
 *   - observables (sessions, stats) refresh reactively;
 *   - cross-engine deviceId filter;
 *   - purgeStale() emits per-session removed events + a single
 *     summary stale.sweeped event.
 */

import { describe, it, expect } from 'vitest';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { EventBus } from '@/events/EventBus';
import { IPAddress, computeIPv4Checksum, IP_PROTO_UDP } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import type { DomainEvent } from '@/events/types';

function buildEngine(): { engine: NATEngine; bus: EventBus; trace: DomainEvent[] } {
  const bus = new EventBus();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const engine = new NATEngine();
  engine.setEventBus(bus);
  engine.setDeviceId('R1', 'router1');
  engine.setInsideInterface('Gi0/0');
  engine.setOutsideInterface('Gi0/1');

  // Default ACL match function and outside iface IP — required for
  // overload PAT to allocate a global IP.
  engine.setACLMatchFn(() => true);
  engine.setInterfaceIPFn((iface) => iface === 'Gi0/1' ? '203.0.113.1' : null);

  // Single overload rule covering everything that matched the ACL.
  engine.addDynamicRule({ aclId: 1, type: 'overload' });

  return { engine, bus, trace };
}

function makeUdpOutboundPkt(srcIp: string, srcPort: number, dstIp: string, dstPort: number): IPv4Packet {
  const udp = {
    type: 'udp' as const,
    sourcePort: srcPort,
    destinationPort: dstPort,
    length: 8 + 16,
    checksum: 0,
    payload: { type: 'raw', data: '0123456789abcdef' } as never,
  };
  const pkt: IPv4Packet = {
    version: 4,
    ihl: 5,
    tos: 0,
    totalLength: 20 + 8 + 16,
    identification: 1,
    flags: 0,
    fragmentOffset: 0,
    ttl: 64,
    protocol: IP_PROTO_UDP,
    checksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(dstIp),
    payload: udp,
  } as never;
  pkt.checksum = computeIPv4Checksum(pkt);
  return pkt;
}

describe('NATEngine — observables surface', () => {
  it('exposes sessions + stats signals', () => {
    const { engine } = buildEngine();
    expect(engine.observables.sessions.get()).toEqual([]);
    expect(engine.observables.stats.get().sessionCount).toBe(0);
  });
});

describe('NATEngine — session creation emits nat.session.created', () => {
  it('emits when an outbound UDP packet creates a new PAT session', () => {
    const { engine, trace } = buildEngine();
    const pkt = makeUdpOutboundPkt('10.0.0.5', 12345, '8.8.8.8', 53);

    const out = engine.translateOutbound(pkt, 'Gi0/1', 'Gi0/0');
    expect(out).not.toBeNull();

    const created = trace.find((e) => e.topic === 'nat.session.created');
    expect(created).toBeDefined();
    const payload = (created as DomainEvent & { topic: 'nat.session.created' }).payload;
    expect(payload.localIp).toBe('10.0.0.5');
    expect(payload.localPort).toBe(12345);
    expect(payload.outsideIp).toBe('8.8.8.8');
    expect(payload.outsidePort).toBe(53);
    expect(payload.kind).toBe('overload');
  });

  it('refreshes the sessions signal after creation', () => {
    const { engine } = buildEngine();
    const pkt = makeUdpOutboundPkt('10.0.0.5', 12345, '8.8.8.8', 53);
    engine.translateOutbound(pkt, 'Gi0/1', 'Gi0/0');

    const sessions = engine.observables.sessions.get();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].localIp).toBe('10.0.0.5');
  });

  it('updates the stats signal on each translation', () => {
    const { engine } = buildEngine();
    const pkt1 = makeUdpOutboundPkt('10.0.0.5', 12345, '8.8.8.8', 53);
    const pkt2 = makeUdpOutboundPkt('10.0.0.6', 23456, '8.8.4.4', 53);
    engine.translateOutbound(pkt1, 'Gi0/1', 'Gi0/0');
    engine.translateOutbound(pkt2, 'Gi0/1', 'Gi0/0');

    const stats = engine.observables.stats.get();
    expect(stats.sessionCount).toBe(2);
    expect(stats.misses).toBe(2);
  });
});

describe('NATEngine — purgeStale emits removed events', () => {
  it('emits per-session removed + one summary stale.sweeped', () => {
    const { engine, trace } = buildEngine();
    const pkt = makeUdpOutboundPkt('10.0.0.5', 12345, '8.8.8.8', 53);
    engine.translateOutbound(pkt, 'Gi0/1', 'Gi0/0');

    trace.length = 0;
    // Force every session to be considered stale (timeout = 0).
    engine.purgeStale(0);

    expect(trace.find((e) => e.topic === 'nat.session.removed')).toBeDefined();
    expect(trace.find((e) => e.topic === 'nat.stale.sweeped')).toBeDefined();
    expect(engine.observables.sessions.get()).toHaveLength(0);
  });

  it('does not emit the summary event when no session was sweeped', () => {
    const { engine, trace } = buildEngine();
    trace.length = 0;
    engine.purgeStale(0);
    expect(trace.find((e) => e.topic === 'nat.stale.sweeped')).toBeUndefined();
  });
});

describe('NATEngine — cross-engine deviceId filter', () => {
  it('two NAT engines on a shared bus do not pollute each other signals', () => {
    const bus = new EventBus();
    const e1 = new NATEngine();
    const e2 = new NATEngine();
    e1.setEventBus(bus);
    e2.setEventBus(bus);
    e1.setDeviceId('R1');
    e2.setDeviceId('R2');
    e1.setInsideInterface('Gi0/0');
    e1.setOutsideInterface('Gi0/1');
    e1.setACLMatchFn(() => true);
    e1.setInterfaceIPFn((iface) => iface === 'Gi0/1' ? '203.0.113.1' : null);
    e1.addDynamicRule({ aclId: 1, type: 'overload' });

    const pkt = makeUdpOutboundPkt('10.0.0.5', 12345, '8.8.8.8', 53);
    e1.translateOutbound(pkt, 'Gi0/1', 'Gi0/0');

    expect(e1.observables.sessions.get()).toHaveLength(1);
    expect(e2.observables.sessions.get()).toHaveLength(0);
  });
});
