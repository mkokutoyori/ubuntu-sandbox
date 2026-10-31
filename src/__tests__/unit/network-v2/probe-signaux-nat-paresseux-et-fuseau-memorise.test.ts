/**
 * Probe: the NAT read-models are computed when read, not once per event, and
 * the time-zone breakdown of a given second is computed once.
 *
 * Measured on the lab stress profile (curl-2000): projectNatSessions 452 ms
 * and partsAt 611 ms of 41 s of CPU, both growing with the number of events.
 *
 * Cases that fall before the change: 4 of 7 (the three LazySignal cases,
 * the type not existing, and the 200000-breakdown bound at about 800 ms).
 * Witnesses that pass either way: the two NAT cases (the per-event rebuild
 * measured under a second even at 6000 sessions in this node lab, so the
 * gain shows in the browser profile, not here; they prove the lazy read-model
 * stays exact) and the partsAt correctness case (non-regression).
 */

import { describe, it, expect } from 'vitest';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { LazySignal } from '@/events/Signal';
import { EventBus } from '@/events/EventBus';
import { IPAddress, computeIPv4Checksum, IP_PROTO_UDP } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { partsAt } from '@/network/core/time/TimeZoneRegistry';
import { TimeZone } from '@/network/core/time/TimeZone';

function udpPacket(srcPort: number): IPv4Packet {
  const pkt: IPv4Packet = {
    type: 'ipv4' as const,
    version: 4,
    ihl: 5,
    tos: 0,
    totalLength: 44,
    identification: 1,
    flags: 0,
    fragmentOffset: 0,
    ttl: 64,
    protocol: IP_PROTO_UDP,
    headerChecksum: 0,
    sourceIP: new IPAddress('10.0.0.5'),
    destinationIP: new IPAddress('8.8.8.8'),
    payload: {
      type: 'udp' as const,
      sourcePort: srcPort,
      destinationPort: 53,
      length: 24,
      checksum: 0,
      payload: { type: 'raw', data: '0123456789abcdef' } as never,
    },
  };
  pkt.headerChecksum = computeIPv4Checksum(pkt);
  return pkt;
}

function natEngine(): NATEngine {
  const engine = new NATEngine();
  engine.setEventBus(new EventBus());
  engine.setDeviceId('R1', 'router1');
  engine.setInsideInterface('Gi0/0');
  engine.setOutsideInterface('Gi0/1');
  engine.setACLMatchFn(() => true);
  engine.setInterfaceIPFn(iface => (iface === 'Gi0/1' ? '203.0.113.1' : null));
  engine.addDynamicRule({ aclId: 1, type: 'overload' });
  return engine;
}

describe('LazySignal', () => {
  it('computes once per invalidation however often it is read', () => {
    let computed = 0;
    const signal = new LazySignal(() => ++computed);
    expect(signal.get()).toBe(1);
    expect(signal.get()).toBe(1);
    signal.invalidate();
    signal.invalidate();
    expect(signal.get()).toBe(2);
    expect(computed).toBe(2);
  });

  it('does not compute while nobody reads or listens', () => {
    let computed = 0;
    const signal = new LazySignal(() => ++computed);
    for (let i = 0; i < 100; i++) signal.invalidate();
    expect(computed).toBe(0);
  });

  it('notifies listeners on invalidation and hands them the fresh value', () => {
    let source = 'a';
    const signal = new LazySignal(() => source);
    const seen: string[] = [];
    const off = signal.subscribe(() => seen.push(signal.get()));
    source = 'b';
    signal.invalidate();
    off();
    source = 'c';
    signal.invalidate();
    expect(seen).toEqual(['b']);
  });
});

describe('NAT observables on a loaded engine', () => {
  it('stay exact: every session created is visible, with the stats to match', () => {
    const engine = natEngine();
    for (let i = 0; i < 50; i++) engine.translateOutbound(udpPacket(1000 + i), 'Gi0/1', 'Gi0/0');
    expect(engine.observables.sessions.get()).toHaveLength(50);
    expect(engine.observables.stats.get().sessionCount).toBe(50);
  });

  it('absorb 2000 sessions without rebuilding the read-model at each one', () => {
    const engine = natEngine();
    const started = performance.now();
    for (let i = 0; i < 2000; i++) engine.translateOutbound(udpPacket(1000 + i), 'Gi0/1', 'Gi0/0');
    const elapsed = performance.now() - started;
    expect(engine.observables.sessions.get()).toHaveLength(2000);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('partsAt', () => {
  const zone = TimeZone.UTC;

  it('answers the same breakdown for every millisecond of a second, and a new one on the next', () => {
    const base = Date.UTC(2026, 9, 31, 5, 44, 19);
    expect(partsAt(zone, base + 999)).toEqual(partsAt(zone, base));
    expect(partsAt(zone, base).second).toBe(19);
    expect(partsAt(zone, base + 1000).second).toBe(20);
  });

  it('computes 200000 breakdowns of one second in under 400 ms', () => {
    const base = Date.UTC(2026, 9, 31, 5, 44, 19);
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) partsAt(zone, base + (i % 1000));
    expect(performance.now() - started).toBeLessThan(400);
  });
});
