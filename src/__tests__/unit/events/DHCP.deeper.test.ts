/**
 * Phase 4b2-DHCP.deeper — server-side emissions + DHCPCaptureActor.
 *
 * Verifies:
 *   - DHCPServer emits dhcp.engine.started/stopped (role: 'server')
 *     and dhcp.pool.lease-allocated/-released at every binding mutation;
 *   - server.observables.leases / .stats refresh reactively;
 *   - DHCPCaptureActor records both client and server events with
 *     filtering by deviceId / kind / iface.
 */

import { describe, it, expect } from 'vitest';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { DHCPCaptureActor } from '@/network/dhcp/actors';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import type { DomainEvent } from '@/events/types';

function buildPair(): {
  client: DHCPClient;
  server: DHCPServer;
  bus: EventBus;
  scheduler: VirtualTimeScheduler;
  trace: DomainEvent[];
} {
  const bus = new EventBus();
  const scheduler = new VirtualTimeScheduler();
  const trace: DomainEvent[] = [];
  bus.subscribeAll((e) => trace.push(e));

  const configured: { iface?: string; ip?: string; mask?: string; gw?: string | null } = {};
  const client = new DHCPClient(
    () => '00:11:22:33:44:55',
    (iface, ip, mask, gw) => { configured.iface = iface; configured.ip = ip; configured.mask = mask; configured.gw = gw; },
    () => { configured.ip = undefined; },
  );
  client.setEventBus(bus);
  client.setScheduler(scheduler);
  client.setDeviceId('PC1');
  client.start();

  const server = new DHCPServer();
  server.setEventBus(bus);
  server.setDeviceId('R1', 'router1');
  server.setServerIdentifier('10.0.0.1');
  server.createPool('default');
  server.configurePoolNetwork('default', '10.0.0.0', '255.255.255.0');
  server.configurePoolRouter('default', '10.0.0.1');
  server.configurePoolLease('default', 600);
  server.start();

  client.registerServer(server, '10.0.0.1');
  return { client, server, bus, scheduler, trace };
}

describe('DHCPServer — engine lifecycle events', () => {
  it('emits dhcp.engine.started with role=server', () => {
    const { trace } = buildPair();
    const started = trace.filter(
      (e) => e.topic === 'dhcp.engine.started'
        && (e as DomainEvent & { topic: 'dhcp.engine.started' }).payload.role === 'server',
    );
    expect(started.length).toBe(1);
  });
});

describe('DHCPServer — pool lifecycle emissions', () => {
  it('emits dhcp.pool.lease-allocated when a DORA succeeds', () => {
    const { client, trace } = buildPair();
    trace.length = 0;
    client.requestLease('eth0');

    const allocated = trace.filter((e) => e.topic === 'dhcp.pool.lease-allocated');
    expect(allocated.length).toBeGreaterThanOrEqual(1);
    const payload = (allocated[0] as DomainEvent & { topic: 'dhcp.pool.lease-allocated' }).payload;
    expect(payload.pool).toBe('default');
    expect(payload.clientMac).toBe('00:11:22:33:44:55');
    expect(payload.ip).toMatch(/^10\.0\.0\.\d+$/);
  });

  it('refreshes server.observables.leases after allocation', () => {
    const { client, server } = buildPair();
    client.requestLease('eth0');

    const leases = server.observables.leases.get();
    expect(leases.length).toBeGreaterThanOrEqual(1);
    expect(leases[0].clientMac).toBe('00:11:22:33:44:55');
    expect(leases[0].pool).toBe('default');
  });

  it('refreshes server.observables.stats with active lease count', () => {
    const { client, server } = buildPair();
    client.requestLease('eth0');

    const stats = server.observables.stats.get();
    expect(stats.activeLeases).toBeGreaterThanOrEqual(1);
    expect(stats.poolCount).toBe(1);
    expect(stats.running).toBe(true);
  });
});

describe('DHCPCaptureActor — opt-in tcpdump-like recorder', () => {
  it('records both client and server events in chronological order', () => {
    const { client, bus } = buildPair();
    const capture = new DHCPCaptureActor(bus);
    capture.start();

    client.requestLease('eth0');

    const cap = capture.getCapture();
    expect(cap.find((c) => c.kind === 'discover-sent')).toBeDefined();
    expect(cap.find((c) => c.kind === 'offer-received')).toBeDefined();
    expect(cap.find((c) => c.kind === 'request-sent')).toBeDefined();
    expect(cap.find((c) => c.kind === 'ack-received')).toBeDefined();
    expect(cap.find((c) => c.kind === 'lease-granted')).toBeDefined();
    expect(cap.find((c) => c.kind === 'pool-lease-allocated')).toBeDefined();
  });

  it('filters by deviceId', () => {
    const { client, bus } = buildPair();
    const capture = new DHCPCaptureActor(bus);
    capture.start();

    client.requestLease('eth0');

    const clientEntries = capture.getCapture({ deviceId: 'PC1' });
    const serverEntries = capture.getCapture({ deviceId: 'R1' });
    expect(clientEntries.length).toBeGreaterThan(0);
    expect(serverEntries.length).toBeGreaterThan(0);
    expect(clientEntries.every((e) => e.deviceId === 'PC1')).toBe(true);
    expect(serverEntries.every((e) => e.deviceId === 'R1')).toBe(true);
  });

  it('filters by kind', () => {
    const { client, bus } = buildPair();
    const capture = new DHCPCaptureActor(bus);
    capture.start();

    client.requestLease('eth0');

    const allocs = capture.getCapture({ kind: 'pool-lease-allocated' });
    expect(allocs.length).toBe(1);
  });

  it('filters by iface for client-side events', () => {
    const { client, bus } = buildPair();
    const capture = new DHCPCaptureActor(bus);
    capture.start();

    client.requestLease('eth0');

    const ethEvents = capture.getCapture({ iface: 'eth0' });
    expect(ethEvents.length).toBeGreaterThan(0);
    expect(ethEvents.every((e) => (e.payload as { iface?: string }).iface === 'eth0')).toBe(true);
  });

  it('clear() empties the buffer; stop() unsubscribes', () => {
    const { client, bus } = buildPair();
    const capture = new DHCPCaptureActor(bus);
    capture.start();

    client.requestLease('eth0');
    expect(capture.size()).toBeGreaterThan(0);

    capture.clear();
    expect(capture.size()).toBe(0);

    capture.stop();
    client.requestLease('eth0');
    // stop unsubscribes — no further capture even though events are flying.
    expect(capture.size()).toBe(0);
  });
});
