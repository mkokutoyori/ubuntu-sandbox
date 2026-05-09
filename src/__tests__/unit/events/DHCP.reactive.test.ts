/**
 * Phase 4b2-DHCP — reactive uplift tests.
 *
 * Verifies:
 *   - timer migration (no native setTimeout left for renewal /
 *     rebinding / expiration);
 *   - DORA emissions (discover.sent → offer.received → request.sent
 *     → ack.received → lease.granted) in causal order;
 *   - state-changed events on every FSM transition;
 *   - lease lifecycle (renewing at T1, rebinding at T2, expiration);
 *   - observables (ifaces, stats) refresh reactively;
 *   - cross-engine deviceId filter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { DHCPServer } from '@/network/dhcp/DHCPServer';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import type { DomainEvent } from '@/events/types';

function buildClientServer(): {
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
  client.setDeviceId('PC1', 'pc1.local');
  client.start();

  const server = new DHCPServer();
  server.setServerIdentifier('10.0.0.1');
  server.createPool('default');
  server.configurePoolNetwork('default', '10.0.0.0', '255.255.255.0');
  server.configurePoolRouter('default', '10.0.0.1');
  server.configurePoolLease('default', 600);
  server.start();

  client.registerServer(server, '10.0.0.1');

  return { client, server, bus, scheduler, trace };
}

describe('DHCPClient — engine lifecycle events', () => {
  it('emits dhcp.engine.started on start()', () => {
    const { trace } = buildClientServer();
    const started = trace.find((e) => e.topic === 'dhcp.engine.started');
    expect(started).toBeDefined();
    expect(
      (started as DomainEvent & { topic: 'dhcp.engine.started' }).payload.role,
    ).toBe('client');
  });

  it('emits dhcp.engine.stopped on stop()', () => {
    const { client, trace } = buildClientServer();
    trace.length = 0;
    client.stop();
    expect(trace.find((e) => e.topic === 'dhcp.engine.stopped')).toBeDefined();
  });
});

describe('DHCPClient — observables surface', () => {
  it('exposes ifaces + stats signals', () => {
    const { client } = buildClientServer();
    expect(client.observables.ifaces.get()).toEqual([]);
    expect(client.observables.stats.get().running).toBe(true);
  });

  it('stats.running reflects start/stop', () => {
    const { client } = buildClientServer();
    expect(client.observables.stats.get().running).toBe(true);
    client.stop();
    expect(client.observables.stats.get().running).toBe(false);
  });
});

describe('DHCPClient — DORA emissions on requestLease()', () => {
  it('emits discover → offer → request → ack → lease.granted in order', () => {
    const { client, trace } = buildClientServer();
    trace.length = 0;
    client.requestLease('eth0');

    const topics = trace.map((e) => e.topic);
    expect(topics).toContain('dhcp.discover.sent');
    expect(topics).toContain('dhcp.offer.received');
    expect(topics).toContain('dhcp.request.sent');
    expect(topics).toContain('dhcp.ack.received');
    expect(topics).toContain('dhcp.lease.granted');

    const idxDiscover = topics.indexOf('dhcp.discover.sent');
    const idxOffer = topics.indexOf('dhcp.offer.received');
    const idxRequest = topics.indexOf('dhcp.request.sent');
    const idxAck = topics.indexOf('dhcp.ack.received');
    const idxGranted = topics.indexOf('dhcp.lease.granted');

    expect(idxDiscover).toBeLessThan(idxOffer);
    expect(idxOffer).toBeLessThan(idxRequest);
    expect(idxRequest).toBeLessThan(idxAck);
    expect(idxAck).toBeLessThan(idxGranted);
  });

  it('emits state-changed events for every FSM transition', () => {
    const { client, trace } = buildClientServer();
    trace.length = 0;
    client.requestLease('eth0');

    const transitions = trace
      .filter((e) => e.topic === 'dhcp.client.state-changed')
      .map((e) => (e as DomainEvent & { topic: 'dhcp.client.state-changed' }).payload);

    expect(transitions.length).toBeGreaterThanOrEqual(3);
    expect(transitions[0].oldState).toBe('INIT');
    expect(transitions[0].newState).toBe('SELECTING');
    expect(transitions[transitions.length - 1].newState).toBe('BOUND');
  });

  it('refreshes the ifaces signal after a successful DORA', () => {
    const { client } = buildClientServer();
    client.requestLease('eth0');
    const ifaces = client.observables.ifaces.get();
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0].state).toBe('BOUND');
    expect(ifaces[0].hasLease).toBe(true);
    expect(ifaces[0].leaseIp).toMatch(/^10\.0\.0\.\d+$/);
  });

  it('updates stats counters after DORA', () => {
    const { client } = buildClientServer();
    client.requestLease('eth0');
    const stats = client.observables.stats.get();
    expect(stats.discoversSent).toBe(1);
    expect(stats.offersReceived).toBe(1);
    expect(stats.requestsSent).toBe(1);
    expect(stats.acksReceived).toBe(1);
    expect(stats.leasesGranted).toBe(1);
    expect(stats.boundCount).toBe(1);
    expect(stats.ifaceCount).toBe(1);
  });
});

describe('DHCPClient — lease lifecycle via VirtualTimeScheduler', () => {
  it('fires the renewal timer at T1 and emits lease.renewing', () => {
    const { client, scheduler, trace } = buildClientServer();
    client.requestLease('eth0');

    // Default lease 600s, T1 = 50% = 300s.
    trace.length = 0;
    scheduler.advance(310_000);

    const renewing = trace.find((e) => e.topic === 'dhcp.lease.renewing');
    expect(renewing).toBeDefined();
  });

  it('fires the expiration timer and emits lease.expired when renewal cannot reach a server', () => {
    const { client, scheduler, trace } = buildClientServer();
    client.requestLease('eth0');

    // Cut the server off so renewal/rebinding fail and the original
    // expiration timer survives. Lease duration is 600s.
    client.clearServers();

    trace.length = 0;
    scheduler.advance(610_000);

    const expired = trace.find((e) => e.topic === 'dhcp.lease.expired');
    expect(expired).toBeDefined();
  });

  it('stop() cancels all per-lease timers', () => {
    const { client, scheduler } = buildClientServer();
    client.requestLease('eth0');
    expect(scheduler.pendingCount()).toBeGreaterThan(0);
    client.stop();
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe('DHCPClient — cross-engine deviceId filter', () => {
  it('two clients on a shared bus do not pollute each other signals', () => {
    const bus = new EventBus();
    const c1 = new DHCPClient(() => 'aa:aa:aa:aa:aa:aa', () => {}, () => {});
    const c2 = new DHCPClient(() => 'bb:bb:bb:bb:bb:bb', () => {}, () => {});
    c1.setEventBus(bus);
    c2.setEventBus(bus);
    c1.setDeviceId('PC1');
    c2.setDeviceId('PC2');
    c1.start();
    c2.start();

    expect(c1.observables.stats.get().running).toBe(true);
    expect(c2.observables.stats.get().running).toBe(true);

    c1.stop();
    expect(c1.observables.stats.get().running).toBe(false);
    expect(c2.observables.stats.get().running).toBe(true);
  });
});
