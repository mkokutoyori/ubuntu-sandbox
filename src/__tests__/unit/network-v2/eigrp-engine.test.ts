/**
 * TDD — real EIGRP engine. Two engines wired as genuine cabled peers
 * form an adjacency ONLY when the AS matches, and each learns the
 * other's really-originated connected networks (AD 90). A lone /
 * AS-mismatched engine has no neighbour and no routes (true state).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EIGRPEngine } from '@/network/eigrp/EIGRPEngine';
import type { RoutingPeer } from '@/network/routing';
import {
  IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';

beforeEach(() => resetCounters());

/** Build a bidirectional real-peer link between two engines. */
function link(a: EIGRPEngine, aHost: string, aIp: string,
              b: EIGRPEngine, bHost: string, bIp: string) {
  const peerOf = (eng: EIGRPEngine, host: string, ip: string): RoutingPeer => ({
    deviceId: host, hostname: host,
    localIface: 'Gi0/0',
    localIp: new IPAddress(host === aHost ? aIp : bIp),
    remoteIface: 'Gi0/0',
    remoteIp: new IPAddress(ip),
    peerEngineFor: (p) => (p === 'eigrp' ? eng : null),
  });
  a.setPeerLocator({ locatePeers: () => [peerOf(b, bHost, bIp)] });
  b.setPeerLocator({ locatePeers: () => [peerOf(a, aHost, aIp)] });
}

function ctx(net: string, ip: string) {
  return {
    connectedNetworks: () => [{
      network: new IPAddress(net),
      mask: new SubnetMask('255.255.255.0'),
      iface: 'Gi0/1',
      localIp: new IPAddress(ip),
    }],
  };
}

describe('EIGRPEngine — real config-driven', () => {
  it('no peer ⇒ no neighbour, no contributed routes', () => {
    const e = new EIGRPEngine('R1');
    e.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    e.enable({ asn: 100, networks: [{ network: '192.168.1.0' }] });
    e.converge();
    expect(e.getNeighbors()).toHaveLength(0);
    expect(e.getContributedRoutes()).toHaveLength(0);
  });

  it('two cabled peers in the same AS form adjacency + exchange routes', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge(); r2.converge();

    expect(r1.getNeighbors()).toHaveLength(1);
    expect(r1.getNeighbors()[0].isUp).toBe(true);
    const routes = r1.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.2.0');  // learned from R2
    expect(routes[0].adminDistance).toBe(90);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
    expect(r2.getContributedRoutes().map((x) => String(x.network)))
      .toContain('192.168.1.0');
  });

  it('AS mismatch ⇒ no adjacency (true state, not a stub)', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.enable({ asn: 200, networks: [{ network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(0);
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('learned route carries the real composite metric (GigE ⇒ 3072)', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    // Defaults are GigE: 256 × (10⁷/10⁶ + (10+10)/10) = 3072.
    expect(r1.getContributedRoutes()[0].metric).toBe(3072);
  });

  it('K-value mismatch blocks the adjacency (RFC 7868 §5.4)', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }],
      kValues: { k1: 1, k2: 1, k3: 1, k4: 0, k5: 0 },
    });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(0);
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('never installs an EIGRP route for its own connected prefix', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    // Both devices share the SAME connected prefix 192.168.9.0/24.
    r1.setDeviceContext(ctx('192.168.9.0', '192.168.9.1'));
    r2.setDeviceContext(ctx('192.168.9.0', '192.168.9.2'));
    r1.enable({ asn: 100, networks: [{ network: '192.168.9.0' }, { network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '192.168.9.0' }, { network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(1);     // adjacency forms…
    expect(r1.getContributedRoutes()).toHaveLength(0); // …connected wins
  });

  it('disable tears the adjacency down reactively', () => {
    const r1 = new EIGRPEngine('R1');
    const r2 = new EIGRPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0', '192.168.1.1'));
    r2.setDeviceContext(ctx('192.168.2.0', '192.168.2.1'));
    r1.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    link(r1, 'R1', '10.0.0.1', r2, 'R2', '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(1);
    r2.disable();
    r1.converge();
    expect(r1.getNeighbors()).toHaveLength(0);
  });
});

describe('EIGRPEngine — DUAL feasibility & variance', () => {
  interface PeerSpec {
    eng: EIGRPEngine; host: string; ip: string; iface: string;
    linkBandwidthKbps?: number; linkDelayUsec?: number;
  }

  /** Wire `self` to several peers at once, with per-link attributes. */
  function multiLink(self: EIGRPEngine, peers: PeerSpec[]) {
    self.setPeerLocator({
      locatePeers: () => peers.map((p): RoutingPeer => ({
        deviceId: p.host, hostname: p.host,
        localIface: p.iface, localIp: new IPAddress('10.0.0.1'),
        remoteIface: 'Gi0/0', remoteIp: new IPAddress(p.ip),
        linkBandwidthKbps: p.linkBandwidthKbps,
        linkDelayUsec: p.linkDelayUsec,
        peerEngineFor: (proto) => (proto === 'eigrp' ? p.eng : null),
      })),
    });
  }

  /** A peer that originates 172.16.0.0/24 with given interface attrs. */
  function originator(id: string, bw?: number, delay?: number): EIGRPEngine {
    const e = new EIGRPEngine(id);
    e.setDeviceContext({
      connectedNetworks: () => [{
        network: new IPAddress('172.16.0.0'),
        mask: new SubnetMask('255.255.255.0'),
        iface: 'Gi0/1',
        localIp: new IPAddress('172.16.0.1'),
        bandwidthKbps: bw, delayUsec: delay,
      }],
    });
    e.enable({ asn: 100, networks: [{ network: '172.16.0.0' }] });
    return e;
  }

  it('default variance 1 installs only the successor (lowest FD)', () => {
    const self = new EIGRPEngine('R1');
    self.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    multiLink(self, [
      { eng: originator('A'), host: 'A', ip: '10.0.0.2', iface: 'Gi0/0' },
      { eng: originator('B'), host: 'B', ip: '10.0.1.2', iface: 'Gi0/1',
        linkBandwidthKbps: 100_000, linkDelayUsec: 100 },
    ]);
    self.converge();
    const routes = self.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2'); // GigE successor
    expect(routes[0].metric).toBe(3072);
  });

  it('variance admits a feasible slower path (unequal-cost sharing)', () => {
    const self = new EIGRPEngine('R1');
    self.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }], variance: 10,
    });
    multiLink(self, [
      { eng: originator('A'), host: 'A', ip: '10.0.0.2', iface: 'Gi0/0' },
      { eng: originator('B'), host: 'B', ip: '10.0.1.2', iface: 'Gi0/1',
        linkBandwidthKbps: 100_000, linkDelayUsec: 100 },
    ]);
    self.converge();
    const routes = self.getContributedRoutes();
    expect(routes).toHaveLength(2);
    // Successor first (FD 3072), feasible alternate second (FD 28416).
    expect(routes[0].metric).toBe(3072);
    expect(routes[1].metric).toBe(28416);
  });

  it('an infeasible path (RD ≥ FD of successor) is never installed', () => {
    const self = new EIGRPEngine('R1');
    self.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }], variance: 128,
    });
    multiLink(self, [
      { eng: originator('A'), host: 'A', ip: '10.0.0.2', iface: 'Gi0/0' },
      // B reaches the prefix through a 10 Mb interface: its reported
      // distance (256256) exceeds the successor's FD (3072).
      { eng: originator('B', 10_000, 10), host: 'B', ip: '10.0.1.2',
        iface: 'Gi0/1' },
    ]);
    self.converge();
    const routes = self.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
  });

  it('maximum-paths caps the number of installed paths per prefix', () => {
    const self = new EIGRPEngine('R1');
    self.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }], maximumPaths: 2,
    });
    multiLink(self, [
      { eng: originator('A'), host: 'A', ip: '10.0.0.2', iface: 'Gi0/0' },
      { eng: originator('B'), host: 'B', ip: '10.0.1.2', iface: 'Gi0/1' },
      { eng: originator('C'), host: 'C', ip: '10.0.2.2', iface: 'Gi0/2' },
    ]);
    self.converge();
    expect(self.getContributedRoutes()).toHaveLength(2); // 3 equal paths
  });
});
