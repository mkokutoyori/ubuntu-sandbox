/**
 * TDD — shared routing-engine foundation. A tiny concrete engine
 * proves the contract: lifecycle, REAL config-driven adjacency (a
 * neighbour forms only when a real peer is located), reactive
 * observables (Signals fire without polling), and RIB contribution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AbstractRoutingProtocolEngine, type RoutingPeer, type RibRoute,
} from '@/network/routing';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

interface ToyConfig { asn: number; networks: string[]; }

class ToyEngine extends AbstractRoutingProtocolEngine<ToyConfig> {
  readonly protocol = 'toy';
  protected defaultConfig(): ToyConfig { return { asn: 0, networks: [] }; }
  protected computeNeighbors(peers: RoutingPeer[]): void {
    const keep = new Set<string>();
    for (const p of peers) {
      // Config-driven: only adjacent if the peer runs a 'toy' engine.
      if (!p.peerEngineFor('toy')) continue;
      keep.add(p.deviceId);
      this.neighbors.upsert(p.deviceId, p.remoteIp ? String(p.remoteIp) : '?',
        p.localIface, 'Established', p.hostname);
    }
    this.neighbors.retainOnly(keep);
  }
  protected computeRoutes(peers: RoutingPeer[]): RibRoute[] {
    if (!this.neighbors.hasEstablished()) return [];
    return this.config.networks.map((n) => ({
      network: new IPAddress(n),
      mask: new SubnetMask('255.255.255.0'),
      nextHop: peers[0]?.remoteIp ?? null,
      iface: peers[0]?.localIface ?? 'n/a',
      protocol: 'toy',
      adminDistance: 200,
      metric: 1,
    }));
  }
}

const peer = (id: string, hasToy: boolean): RoutingPeer => ({
  deviceId: id,
  hostname: id,
  localIface: 'Gi0/0',
  localIp: new IPAddress('10.0.0.1'),
  remoteIface: 'Gi0/0',
  remoteIp: new IPAddress('10.0.0.2'),
  peerEngineFor: (p) => (hasToy && p === 'toy' ? {} : null),
});

describe('AbstractRoutingProtocolEngine (foundation)', () => {
  it('lifecycle: disabled by default, enable/disable idempotent', () => {
    const e = new ToyEngine('R1');
    expect(e.isEnabled()).toBe(false);
    expect(e.getContributedRoutes()).toEqual([]);
    e.enable({ asn: 65000, networks: ['192.168.1.0'] });
    expect(e.isEnabled()).toBe(true);
    e.enable();                       // idempotent
    expect(e.isEnabled()).toBe(true);
    e.disable();
    expect(e.isEnabled()).toBe(false);
  });

  it('REAL config-driven: no peer ⇒ no neighbour, no routes', () => {
    const e = new ToyEngine('R1');
    e.enable({ networks: ['192.168.1.0'] });
    e.converge();
    expect(e.getNeighbors()).toHaveLength(0);
    expect(e.getContributedRoutes()).toHaveLength(0);
  });

  it('forms an adjacency only with a real same-protocol peer', () => {
    const e = new ToyEngine('R1');
    e.enable({ networks: ['192.168.1.0'] });
    e.setPeerLocator({ locatePeers: () => [peer('R2', false)] });
    e.converge();
    expect(e.getNeighbors()).toHaveLength(0);   // peer has no toy engine

    e.setPeerLocator({ locatePeers: () => [peer('R2', true)] });
    e.converge();
    const ns = e.getNeighbors();
    expect(ns).toHaveLength(1);
    expect(ns[0].isUp).toBe(true);
    expect(ns[0].state).toBe('Established');
    const routes = e.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.1.0');
    expect(routes[0].adminDistance).toBe(200);
  });

  it('observables are reactive (fire on converge, no polling)', () => {
    const e = new ToyEngine('R1');
    let hits = 0;
    e.observables.neighbors.subscribe(() => { hits++; });
    e.observables.stats.subscribe(() => { hits++; });
    e.enable({ networks: ['10.1.1.0'] });
    e.setPeerLocator({ locatePeers: () => [peer('R2', true)] });
    e.converge();
    expect(hits).toBeGreaterThan(0);
    expect(e.observables.stats.get().establishedNeighborCount).toBe(1);
    expect(e.observables.routes.get()).toHaveLength(1);
    e.disable();
    expect(e.observables.stats.get().running).toBe(false);
    expect(e.observables.neighbors.get()).toHaveLength(0);
  });
});
