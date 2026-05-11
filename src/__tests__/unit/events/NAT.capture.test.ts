/**
 * Phase 4b2-NAT — NATCaptureActor opt-in recorder.
 */

import { describe, it, expect } from 'vitest';
import { NATEngine } from '@/network/devices/router/NATEngine';
import { NATCaptureActor } from '@/network/devices/router/nat/actors';
import { EventBus } from '@/events/EventBus';
import { IPAddress, computeIPv4Checksum, IP_PROTO_UDP } from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';

function buildEngine(): { engine: NATEngine; bus: EventBus } {
  const bus = new EventBus();
  const engine = new NATEngine();
  engine.setEventBus(bus);
  engine.setDeviceId('R1');
  engine.setInsideInterface('Gi0/0');
  engine.setOutsideInterface('Gi0/1');
  engine.setACLMatchFn(() => true);
  engine.setInterfaceIPFn((iface) => iface === 'Gi0/1' ? '203.0.113.1' : null);
  engine.addDynamicRule({ aclId: 1, type: 'overload' });
  return { engine, bus };
}

function makeUdp(srcIp: string, srcPort: number, dstIp: string, dstPort: number): IPv4Packet {
  const udp = {
    type: 'udp' as const,
    sourcePort: srcPort,
    destinationPort: dstPort,
    length: 8 + 16,
    checksum: 0,
    payload: { type: 'raw', data: '0123456789abcdef' } as never,
  };
  const pkt: IPv4Packet = {
    version: 4, ihl: 5, tos: 0, totalLength: 44,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
    protocol: IP_PROTO_UDP, checksum: 0,
    sourceIP: new IPAddress(srcIp), destinationIP: new IPAddress(dstIp),
    payload: udp,
  } as never;
  pkt.checksum = computeIPv4Checksum(pkt);
  return pkt;
}

describe('NATCaptureActor — opt-in recorder', () => {
  it('records session-created events on every translateOutbound', () => {
    const { engine, bus } = buildEngine();
    const capture = new NATCaptureActor(bus);
    capture.start();

    engine.translateOutbound(makeUdp('10.0.0.5', 1000, '8.8.8.8', 53), 'Gi0/1', 'Gi0/0');
    engine.translateOutbound(makeUdp('10.0.0.6', 2000, '8.8.4.4', 53), 'Gi0/1', 'Gi0/0');

    const created = capture.getCapture({ kind: 'session-created' });
    expect(created.length).toBe(2);
  });

  it('records session-removed and stale-sweeped on purge', () => {
    const { engine, bus } = buildEngine();
    const capture = new NATCaptureActor(bus);
    capture.start();

    engine.translateOutbound(makeUdp('10.0.0.5', 1000, '8.8.8.8', 53), 'Gi0/1', 'Gi0/0');
    capture.clear();
    // -1 forces every session timestamp diff (>= 0) to exceed the timeout.
    engine.purgeStale(-1);

    expect(capture.getCapture({ kind: 'session-removed' })).toHaveLength(1);
    expect(capture.getCapture({ kind: 'stale-sweeped' })).toHaveLength(1);
  });

  it('filters by localIp', () => {
    const { engine, bus } = buildEngine();
    const capture = new NATCaptureActor(bus);
    capture.start();

    engine.translateOutbound(makeUdp('10.0.0.5', 1000, '8.8.8.8', 53), 'Gi0/1', 'Gi0/0');
    engine.translateOutbound(makeUdp('10.0.0.6', 2000, '8.8.4.4', 53), 'Gi0/1', 'Gi0/0');

    const r1 = capture.getCapture({ localIp: '10.0.0.5' });
    const r2 = capture.getCapture({ localIp: '10.0.0.6' });
    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
  });

  it('caps the buffer and supports clear/stop', () => {
    const { engine, bus } = buildEngine();
    const capture = new NATCaptureActor(bus, 4);
    capture.start();

    for (let i = 0; i < 10; i++) {
      engine.translateOutbound(makeUdp(`10.0.0.${i + 1}`, 1000 + i, '8.8.8.8', 53), 'Gi0/1', 'Gi0/0');
    }
    expect(capture.size()).toBeLessThanOrEqual(5);
    expect(capture.size()).toBeGreaterThan(0);

    capture.clear();
    expect(capture.size()).toBe(0);

    capture.stop();
    engine.translateOutbound(makeUdp('10.0.0.99', 9999, '8.8.8.8', 53), 'Gi0/1', 'Gi0/0');
    expect(capture.size()).toBe(0);
  });
});
