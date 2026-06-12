/**
 * TDD — real EIGRP engine over the wire seam. Engines converse ONLY in
 * EIGRP packets (Hello/Update) delivered by a test cable: an adjacency
 * forms when the AS and K values match on an interface activated by a
 * `network` statement, and routes are learned from received Updates —
 * never by reading a peer engine object. A lone / AS-mismatched engine
 * has no neighbour and no routes (true state).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EIGRPEngine } from '@/network/eigrp/EIGRPEngine';
import { EIGRP_MULTICAST_IP } from '@/network/eigrp/packets';
import type { ConnectedNetwork } from '@/network/routing/RoutingPeerLocator';
import { EventBus } from '@/events/EventBus';
import {
  IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';

beforeEach(() => resetCounters());

interface IfaceSpec {
  iface: string;
  ip: string;
  maskBits?: number;
  bandwidthKbps?: number;
  delayUsec?: number;
}

interface RibSpec { net: string; mask: string; type: string; }

/** A device under test: one engine + its real connected networks. */
class TestDevice {
  readonly eng: EIGRPEngine;
  private readonly ifaces = new Map<string, IfaceSpec>();
  private readonly links = new Map<string, { dev: TestDevice; iface: string }>();
  private rib: RibSpec[] = [];

  constructor(readonly id: string, ifaces: IfaceSpec[], rib: RibSpec[] = []) {
    for (const i of ifaces) this.ifaces.set(i.iface, i);
    this.rib = rib;
    this.eng = new EIGRPEngine(id);
    this.eng.setDeviceContext({
      connectedNetworks: () => this.connected(),
      ribRoutes: () => this.rib.map((r) => ({
        network: new IPAddress(r.net),
        mask: new SubnetMask(r.mask),
        type: r.type,
      })),
    });
    this.eng.setWire({
      send: (iface, destIp, packet) => {
        const link = this.links.get(iface);
        if (!link) return;            // nothing cabled: frame goes nowhere
        const remoteIp = this.ifaces.get(iface)!.ip;
        link.dev.eng.processPacket(link.iface, remoteIp, packet,
          destIp === EIGRP_MULTICAST_IP);
      },
    });
  }

  private connected(): ConnectedNetwork[] {
    return [...this.ifaces.values()].map((i) => {
      const mask = SubnetMask.fromCIDR(i.maskBits ?? 24);
      const octets = i.ip.split('.').map(Number);
      const m = mask.getOctets();
      return {
        network: new IPAddress(octets.map((v, k) => v & m[k]).join('.')),
        mask,
        iface: i.iface,
        localIp: new IPAddress(i.ip),
        bandwidthKbps: i.bandwidthKbps,
        delayUsec: i.delayUsec,
      };
    });
  }

  /** Bidirectional test cable between two device interfaces. */
  static cable(a: TestDevice, aIface: string, b: TestDevice, bIface: string) {
    a.links.set(aIface, { dev: b, iface: bIface });
    b.links.set(bIface, { dev: a, iface: aIface });
  }

  static cut(a: TestDevice, aIface: string) {
    const link = a.links.get(aIface);
    if (link) link.dev.links.delete(link.iface);
    a.links.delete(aIface);
  }
}

/** R(lan, linkIp) — one LAN interface + one link interface. */
function device(id: string, lanIp: string, linkIp: string,
  link?: Partial<IfaceSpec>): TestDevice {
  return new TestDevice(id, [
    { iface: 'Gi0/1', ip: lanIp },
    { iface: 'Gi0/0', ip: linkIp, maskBits: 24, ...link },
  ]);
}

describe('EIGRPEngine — real config-driven, over the wire', () => {
  it('no peer ⇒ no neighbour, no contributed routes', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r1.eng.getContributedRoutes()).toHaveLength(0);
  });

  it('two cabled peers in the same AS form adjacency + exchange routes', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge(); r2.eng.converge();

    expect(r1.eng.getNeighbors()).toHaveLength(1);
    expect(r1.eng.getNeighbors()[0].isUp).toBe(true);
    expect(r1.eng.getNeighbors()[0].address).toBe('10.0.0.2');
    const routes = r1.eng.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.2.0');  // learned from R2
    expect(routes[0].adminDistance).toBe(90);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
    expect(r2.eng.getContributedRoutes().map((x) => String(x.network)))
      .toContain('192.168.1.0');
  });

  it('AS mismatch ⇒ no adjacency (true state, not a stub)', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 200, networks: [{ network: '10.0.0.0' }] });
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r1.eng.getContributedRoutes()).toHaveLength(0);
  });

  it('no adjacency on an interface not covered by a network statement (IOS rule)', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    // R1 never activates the 10.0.0.0 link: it must not hello there.
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge(); r2.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r2.eng.getNeighbors()).toHaveLength(0);
  });

  it('passive-interface suppresses the adjacency on that interface', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }],
      passive: new Set(['Gi0/0']),
    });
    r2.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r1.eng.converge(); r2.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r2.eng.getNeighbors()).toHaveLength(0);
  });

  it('learned route carries the real composite metric (GigE ⇒ 3072)', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge();
    // Defaults are GigE: 256 × (10⁷/10⁶ + (10+10)/10) = 3072.
    expect(r1.eng.getContributedRoutes()[0].metric).toBe(3072);
  });

  it('K-value mismatch blocks the adjacency (RFC 7868 §5.4)', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }],
      kValues: { k1: 1, k2: 1, k3: 1, k4: 0, k5: 0 },
    });
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r1.eng.getContributedRoutes()).toHaveLength(0);
  });

  it('never installs an EIGRP route for its own connected prefix', () => {
    // Both devices share the SAME connected prefix 192.168.9.0/24.
    const r1 = device('R1', '192.168.9.1', '10.0.0.1');
    const r2 = device('R2', '192.168.9.2', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.9.0' }, { network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.9.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(1);     // adjacency forms…
    expect(r1.eng.getContributedRoutes().map((r) => String(r.network)))
      .not.toContain('192.168.9.0');                   // …connected wins
  });

  it('disable tears the adjacency down reactively', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(1);
    r2.eng.disable();
    r1.eng.converge();
    expect(r1.eng.getNeighbors()).toHaveLength(0);
  });

  it('a cut cable silences the conversation: neighbour and routes expire', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    r1.eng.converge();
    expect(r1.eng.getContributedRoutes()).toHaveLength(1);
    TestDevice.cut(r1, 'Gi0/0');
    r1.eng.converge();           // next hello round hears nothing back
    expect(r1.eng.getNeighbors()).toHaveLength(0);
    expect(r1.eng.getContributedRoutes()).toHaveLength(0);
  });

  it('refreshFromCache reflects learned routes without a hello round', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    // R2's enable() pumps a round; R1 receives and answers but its own
    // route set was computed before R2's Update arrived.
    r2.eng.enable({ asn: 100, networks: [{ network: '192.168.2.0' }, { network: '10.0.0.0' }] });
    r1.eng.refreshFromCache();   // data path: no frames, cached state
    expect(r1.eng.getContributedRoutes().map((r) => String(r.network)))
      .toContain('192.168.2.0');
    // …and a cut cable must NOT be noticed by a cache refresh (the
    // FIB's disconnected-port check covers the data path instead).
    TestDevice.cut(r1, 'Gi0/0');
    r1.eng.refreshFromCache();
    expect(r1.eng.getNeighbors()).toHaveLength(1);
  });
});

describe('EIGRPEngine — distance-vector propagation (multi-hop)', () => {
  function chain(): { r1: TestDevice; r2: TestDevice; r3: TestDevice } {
    const r1 = device('R1', '192.168.1.1', '10.0.12.1');
    const r2 = new TestDevice('R2', [
      { iface: 'Gi0/0', ip: '10.0.12.2' },
      { iface: 'Gi0/1', ip: '10.0.23.2' },
    ]);
    const r3 = device('R3', '172.16.0.1', '10.0.23.3');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    TestDevice.cable(r3, 'Gi0/0', r2, 'Gi0/1');
    r1.eng.enable({ asn: 100, networks: [{ network: '192.168.1.0' }, { network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r3.eng.enable({ asn: 100, networks: [{ network: '172.16.0.0', wildcard: '0.0.255.255' }, { network: '10.0.0.0' }] });
    return { r1, r2, r3 };
  }

  it('R1 learns R3\'s LAN through R2 with the accumulated vector metric', () => {
    const { r1 } = chain();
    r1.eng.converge();
    const learned = r1.eng.getContributedRoutes()
      .find((r) => String(r.network) === '172.16.0.0');
    expect(learned).toBeDefined();
    expect(String(learned!.nextHop)).toBe('10.0.12.2');   // via R2
    // GigE ×3 segments: 256 × (10⁷/10⁶ + (10+10+10)/10) = 3328.
    expect(learned!.metric).toBe(3328);
  });

  it('split horizon: a withdrawn origin does not echo back from downstream', () => {
    const { r1, r2, r3 } = chain();
    r1.eng.converge(); r2.eng.converge(); r3.eng.converge();
    expect(r3.eng.getContributedRoutes().map((r) => String(r.network)))
      .toContain('192.168.1.0');
    // R1 leaves the AS entirely.
    r1.eng.disable();
    r2.eng.converge();
    expect(r2.eng.getContributedRoutes().map((r) => String(r.network)))
      .not.toContain('192.168.1.0');
    r3.eng.converge();
    // R3 must NOT keep (or feed back) the dead prefix.
    expect(r3.eng.getContributedRoutes().map((r) => String(r.network)))
      .not.toContain('192.168.1.0');
    expect(r2.eng.getContributedRoutes().map((r) => String(r.network)))
      .not.toContain('192.168.1.0');
  });
});

describe('EIGRPEngine — DUAL feasibility & variance', () => {
  /**
   * `self` is linked to several originators of 172.16.0.0/24, each over
   * its own interface with explicit link attributes.
   */
  function star(selfLinks: Array<{
    iface: string; selfIp: string; peerIp: string;
    bandwidthKbps?: number; delayUsec?: number;
    peerLan?: { bandwidthKbps?: number; delayUsec?: number };
  }>, selfCfg: Partial<{ variance: number; maximumPaths: number }> = {}) {
    const self = new TestDevice('R1', selfLinks.map((l) => ({
      iface: l.iface, ip: l.selfIp,
      bandwidthKbps: l.bandwidthKbps, delayUsec: l.delayUsec,
    })));
    self.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }], ...selfCfg });
    for (const l of selfLinks) {
      const peer = new TestDevice(`P-${l.iface}`, [
        { iface: 'Gi0/0', ip: l.peerIp },
        { iface: 'Gi0/1', ip: '172.16.0.1', ...l.peerLan },
      ]);
      peer.eng.enable({
        asn: 100,
        networks: [{ network: '172.16.0.0', wildcard: '0.0.255.255' }, { network: '10.0.0.0' }],
      });
      TestDevice.cable(self, l.iface, peer, 'Gi0/0');
    }
    return self;
  }

  it('default variance 1 installs only the successor (lowest FD)', () => {
    const self = star([
      { iface: 'Gi0/0', selfIp: '10.0.0.1', peerIp: '10.0.0.2' },
      { iface: 'Gi0/1', selfIp: '10.0.1.1', peerIp: '10.0.1.2',
        bandwidthKbps: 100_000, delayUsec: 100 },
    ]);
    self.eng.converge();
    const routes = self.eng.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2'); // GigE successor
    expect(routes[0].metric).toBe(3072);
  });

  it('variance admits a feasible slower path (unequal-cost sharing)', () => {
    const self = star([
      { iface: 'Gi0/0', selfIp: '10.0.0.1', peerIp: '10.0.0.2' },
      { iface: 'Gi0/1', selfIp: '10.0.1.1', peerIp: '10.0.1.2',
        bandwidthKbps: 100_000, delayUsec: 100 },
    ], { variance: 10 });
    self.eng.converge();
    const routes = self.eng.getContributedRoutes();
    expect(routes).toHaveLength(2);
    // Successor first (FD 3072), feasible alternate second (FD 28416).
    expect(routes[0].metric).toBe(3072);
    expect(routes[1].metric).toBe(28416);
  });

  it('an infeasible path (RD ≥ FD of successor) is never installed', () => {
    const self = star([
      { iface: 'Gi0/0', selfIp: '10.0.0.1', peerIp: '10.0.0.2' },
      // B reaches the prefix through a 10 Mb interface: its reported
      // distance (256256) exceeds the successor's FD (3072).
      { iface: 'Gi0/1', selfIp: '10.0.1.1', peerIp: '10.0.1.2',
        peerLan: { bandwidthKbps: 10_000, delayUsec: 10 } },
    ], { variance: 128 });
    self.eng.converge();
    const routes = self.eng.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
  });

  it('maximum-paths caps the number of installed paths per prefix', () => {
    const self = star([
      { iface: 'Gi0/0', selfIp: '10.0.0.1', peerIp: '10.0.0.2' },
      { iface: 'Gi0/1', selfIp: '10.0.1.1', peerIp: '10.0.1.2' },
      { iface: 'Gi0/2', selfIp: '10.0.2.1', peerIp: '10.0.2.2' },
    ], { maximumPaths: 2 });
    self.eng.converge();
    expect(self.eng.getContributedRoutes()).toHaveLength(2); // 3 equal paths
  });
});

describe('K-value mismatch diagnostics', () => {
  it('publishes eigrp.neighbor.k-value-mismatch instead of hiding the peer silently', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({
      asn: 100, networks: [{ network: '10.0.0.0' }],
      kValues: { k1: 1, k2: 1, k3: 1, k4: 0, k5: 0 },
    });

    const bus = new EventBus();
    r1.eng.setBus(bus);
    const mismatches: Array<{ neighborIp: string; asn: number }> = [];
    bus.subscribe('eigrp.neighbor.k-value-mismatch', (e) =>
      mismatches.push(e.payload as { neighborIp: string; asn: number }));

    r1.eng.converge();

    expect(r1.eng.getNeighbors()).toHaveLength(0); // adjacency still blocked
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
    expect(mismatches[0].neighborIp).toBe('10.0.0.2');
    expect(mismatches[0].asn).toBe(100);
  });
});

describe('Redistribution into EIGRP', () => {
  function withStatic(id: string, lan: string, link: string,
    rib: RibSpec[]): TestDevice {
    const d = new TestDevice(id, [
      { iface: 'Gi0/1', ip: lan },
      { iface: 'Gi0/0', ip: link },
    ], rib);
    return d;
  }

  it('redistribute static advertises the prefix as external (AD 170)', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = withStatic('R2', '192.168.2.1', '10.0.0.2',
      [{ net: '172.30.0.0', mask: '255.255.0.0', type: 'static' }]);
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });

    r1.eng.converge();
    expect(r1.eng.getContributedRoutes().find(
      (r) => String(r.network) === '172.30.0.0')).toBeUndefined();

    r2.eng.setRedistribution('static');
    r1.eng.converge();
    const learned = r1.eng.getContributedRoutes().find(
      (r) => String(r.network) === '172.30.0.0');
    expect(learned).toBeDefined();
    expect(learned!.adminDistance).toBe(170);
  });

  it('redistribute connected covers networks outside any network statement', () => {
    const r1 = device('R1', '192.168.1.1', '10.0.0.1');
    const r2 = device('R2', '192.168.2.1', '10.0.0.2');
    TestDevice.cable(r1, 'Gi0/0', r2, 'Gi0/0');
    r1.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });
    r2.eng.enable({ asn: 100, networks: [{ network: '10.0.0.0' }] });

    r1.eng.converge();
    expect(r1.eng.getContributedRoutes().find(
      (r) => String(r.network) === '192.168.2.0')).toBeUndefined();

    r2.eng.setRedistribution('connected');
    r1.eng.converge();
    const learned = r1.eng.getContributedRoutes().find(
      (r) => String(r.network) === '192.168.2.0');
    expect(learned).toBeDefined();
    expect(learned!.adminDistance).toBe(170);
  });
});
