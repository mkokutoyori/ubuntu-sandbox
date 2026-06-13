/**
 * Real BGP engine over genuine TCP/179 sessions (no god-mode peer-engine
 * reads). Peers exchange OPEN/KEEPALIVE/UPDATE over a synchronous fabric
 * that mimics the cable: a session reaches Established only with a
 * reciprocally configured peer carrying the right AS, and routes are
 * learned solely from the UPDATEs that arrive (Adj-RIB-In). True state,
 * no fabricated "up".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BGPEngine, type BgpPeerLink, type BgpWire,
} from '@/network/bgp/BGPEngine';
import type { BgpTransport } from '@/network/bgp/BgpSession';
import type { BgpMessage } from '@/network/bgp/messages';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => { resetCounters(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

function ctx(net: string) {
  return {
    connectedNetworks: () => [{
      network: new IPAddress(net),
      mask: new SubnetMask('255.255.255.0'),
      iface: 'Gi0/1',
      localIp: new IPAddress(net.replace(/0$/, '1')),
    }],
  };
}

/** A pair of transports whose sends deliver synchronously to each other. */
function syncPair(): [BgpTransport, BgpTransport] {
  const h: Array<((m: BgpMessage) => void) | null> = [null, null];
  const c: Array<(() => void) | null> = [null, null];
  const pendingClose = [false, false];
  let open = true;
  const make = (self: 0 | 1, peer: 0 | 1): BgpTransport => ({
    send: (m) => { if (open) h[peer]?.(m); },
    close: () => {
      if (!open) return;
      open = false;
      if (c[peer]) c[peer]!(); else pendingClose[peer] = true;
    },
    onMessage: (fn) => { h[self] = fn; },
    onClose: (fn) => { c[self] = fn; if (pendingClose[self]) { pendingClose[self] = false; fn(); } },
  });
  return [make(0, 1), make(1, 0)];
}

interface Ep { eng: BGPEngine; ip: string; iface?: string; }

/**
 * Install BgpWire transports so configured neighbours peer over real
 * (synchronous) TCP/179 sessions — the test analogue of the cable. The
 * initiator's first send triggers the peer's acceptInbound (the SYN), so a
 * peer with no reciprocal config refuses and tears the session down.
 */
function fabric(links: Array<[Ep, Ep]>): void {
  interface Rec {
    myIp: string; myIface: string;
    remoteEng: BGPEngine; remoteIp: string; remoteIface: string;
  }
  const index = new Map<BGPEngine, Map<string, Rec>>();
  const idx = (e: BGPEngine) => {
    let m = index.get(e);
    if (!m) { m = new Map(); index.set(e, m); }
    return m;
  };
  for (const [a, b] of links) {
    const ai = a.iface ?? 'Gi0/0', bi = b.iface ?? 'Gi0/0';
    idx(a.eng).set(b.ip, { myIp: a.ip, myIface: ai, remoteEng: b.eng, remoteIp: b.ip, remoteIface: bi });
    idx(b.eng).set(a.ip, { myIp: b.ip, myIface: bi, remoteEng: a.eng, remoteIp: a.ip, remoteIface: ai });
  }
  for (const [eng, m] of index) {
    const wire: BgpWire = {
      connect: (remoteIp): BgpPeerLink | null => {
        const rec = m.get(remoteIp);
        if (!rec) return null;
        const [near, far] = syncPair();
        let accepted = false;
        const trig: BgpTransport = {
          send: (msg) => {
            if (!accepted) {
              accepted = true;
              rec.remoteEng.acceptInbound({
                neighborIp: rec.myIp, localIp: rec.remoteIp,
                localIface: rec.remoteIface, transport: far,
              });
            }
            near.send(msg);
          },
          close: () => near.close(),
          onMessage: (fn) => near.onMessage(fn),
          onClose: (fn) => near.onClose(fn),
        };
        return { neighborIp: remoteIp, localIp: rec.myIp, localIface: rec.myIface, transport: trig };
      },
    };
    eng.setWire(wire);
  }
}

function link(a: BGPEngine, aIp: string, b: BGPEngine, bIp: string): void {
  fabric([[{ eng: a, ip: aIp }, { eng: b, ip: bIp }]]);
}

describe('BGPEngine — real config-driven', () => {
  it('configured neighbour with no real peer ⇒ Idle, no routes', () => {
    const r1 = new BGPEngine('R1');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r1.enable({ asn: 65001 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r1.converge();
    const n = r1.getNeighbors();
    expect(n).toHaveLength(1);
    expect(n[0].state).toBe('Idle');
    expect(n[0].isUp).toBe(false);
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('reciprocal eBGP peers reach Established and exchange routes', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    expect(r1.getNeighbors()[0].state).toBe('Established');
    expect(r1.getNeighbors()[0].isUp).toBe(true);
    const routes = r1.getContributedRoutes();
    expect(routes).toHaveLength(1);
    expect(String(routes[0].network)).toBe('192.168.2.0');
    expect(routes[0].adminDistance).toBe(20);          // eBGP
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
  });

  it('peer present but not reciprocally configured ⇒ Active (no routes)', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    // R2 has NO neighbor pointing back.
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge();
    expect(r1.getNeighbors()[0].state).toBe('Active');
    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('iBGP (same AS) yields AD 200', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctx('192.168.1.0'));
    r2.setDeviceContext(ctx('192.168.2.0'));
    r1.enable({ asn: 65000 });
    r2.enable({ asn: 65000 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65000, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65000, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge();
    const routes = r1.getContributedRoutes();
    expect(routes[0].adminDistance).toBe(200);
  });
});

describe('BGPEngine — RFC 4271 §9.1.1 best-path selection', () => {
  /** Two peers (B, C) both originating 172.16.0.0/24 toward `self`. */
  function dualHomedSetup(opts: {
    selfAsn: number; bAsn: number; cAsn: number;
    bRouterId?: string; cRouterId?: string;
    bWeight?: number; cWeight?: number;
    bLocalPref?: number; cLocalPref?: number;
  }) {
    const self = new BGPEngine('SELF');
    const b = new BGPEngine('B');
    const c = new BGPEngine('C');
    self.setDeviceContext(ctx('192.168.1.0'));
    for (const e of [b, c]) {
      e.setDeviceContext({
        connectedNetworks: () => [{
          network: new IPAddress('172.16.0.0'),
          mask: new SubnetMask('255.255.255.0'),
          iface: 'Gi0/1',
          localIp: new IPAddress('172.16.0.1'),
        }],
      });
    }
    self.enable({ asn: opts.selfAsn });
    b.enable({ asn: opts.bAsn, routerId: opts.bRouterId,
      defaultLocalPref: opts.bLocalPref ?? 100 });
    c.enable({ asn: opts.cAsn, routerId: opts.cRouterId,
      defaultLocalPref: opts.cLocalPref ?? 100 });
    b.getConfig().networks.push({ network: '172.16.0.0', mask: '255.255.255.0' });
    c.getConfig().networks.push({ network: '172.16.0.0', mask: '255.255.255.0' });

    self.getConfig().neighbors.set('10.0.0.2',
      { ip: '10.0.0.2', remoteAs: opts.bAsn, activated: true, weight: opts.bWeight });
    self.getConfig().neighbors.set('10.0.1.2',
      { ip: '10.0.1.2', remoteAs: opts.cAsn, activated: true, weight: opts.cWeight });
    b.getConfig().neighbors.set('10.0.0.1',
      { ip: '10.0.0.1', remoteAs: opts.selfAsn, activated: true });
    c.getConfig().neighbors.set('10.0.1.1',
      { ip: '10.0.1.1', remoteAs: opts.selfAsn, activated: true });

    fabric([
      [{ eng: self, ip: '10.0.0.1', iface: 'Gi0/0' }, { eng: b, ip: '10.0.0.2', iface: 'Gi0/0' }],
      [{ eng: self, ip: '10.0.1.1', iface: 'Gi0/1' }, { eng: c, ip: '10.0.1.2', iface: 'Gi0/0' }],
    ]);
    self.converge();
    return self;
  }

  it('installs exactly ONE best path per prefix (not first-seen)', () => {
    const self = dualHomedSetup({
      selfAsn: 65001, bAsn: 65002, cAsn: 65003,
      bRouterId: '2.2.2.2', cRouterId: '3.3.3.3',
    });
    const routes = self.getContributedRoutes();
    expect(routes).toHaveLength(1);
  });

  it('highest weight wins first (Cisco step 1)', () => {
    const self = dualHomedSetup({
      selfAsn: 65001, bAsn: 65002, cAsn: 65003,
      bRouterId: '2.2.2.2', cRouterId: '3.3.3.3',
      cWeight: 200,                       // C must win despite higher RID
    });
    expect(String(self.getContributedRoutes()[0].nextHop)).toBe('10.0.1.2');
  });

  it('a prefix originated inside the AS (iBGP, empty AS_PATH) beats an ' +
     'external path with a longer AS_PATH (step 4)', () => {
    const self = dualHomedSetup({
      selfAsn: 65001, bAsn: 65001 /* iBGP */, cAsn: 65003 /* eBGP */,
      bRouterId: '2.2.2.2', cRouterId: '3.3.3.3',
    });
    const routes = self.getContributedRoutes();
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
    expect(routes[0].adminDistance).toBe(200);
  });

  it('higher LOCAL_PREF wins among iBGP paths (step 2)', () => {
    const self = dualHomedSetup({
      selfAsn: 65001, bAsn: 65001, cAsn: 65001,   // both iBGP
      bRouterId: '2.2.2.2', cRouterId: '3.3.3.3',
      cLocalPref: 200,
    });
    expect(String(self.getContributedRoutes()[0].nextHop)).toBe('10.0.1.2');
  });

  it('lowest router-id breaks remaining ties (step 9)', () => {
    const self = dualHomedSetup({
      selfAsn: 65001, bAsn: 65002, cAsn: 65003,
      bRouterId: '9.9.9.9', cRouterId: '1.1.1.1',
    });
    expect(String(self.getContributedRoutes()[0].nextHop)).toBe('10.0.1.2');
  });

  it('never installs a BGP route for its own connected prefix', () => {
    const self = new BGPEngine('SELF');
    const b = new BGPEngine('B');
    self.setDeviceContext(ctx('192.168.1.0'));
    b.setDeviceContext(ctx('192.168.1.0'));     // same prefix as self
    self.enable({ asn: 65001 });
    b.enable({ asn: 65002 });
    self.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    b.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    b.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    link(self, '10.0.0.1', b, '10.0.0.2');
    self.converge();
    expect(self.getNeighbors()[0].state).toBe('Established');
    expect(self.getContributedRoutes()).toHaveLength(0);
  });
});

// ─── Transitive propagation, AS_PATH and loop prevention ────────────

/** Wire several point-to-point links into one synchronous fabric. */
function mesh(links: Array<[BGPEngine, string, BGPEngine, string]>): void {
  fabric(links.map(([a, aIp, b, bIp]) =>
    [{ eng: a, ip: aIp }, { eng: b, ip: bIp }] as [Ep, Ep]));
}

function router(name: string, asn: number, net: string): BGPEngine {
  const e = new BGPEngine(name);
  e.setDeviceContext(ctx(net));
  e.enable({ asn });
  e.getConfig().networks.push({ network: net, mask: '255.255.255.0' });
  return e;
}

function neighbor(a: BGPEngine, ip: string, remoteAs: number) {
  a.getConfig().neighbors.set(ip, { ip, remoteAs, activated: true });
}

describe('BGPEngine — AS_PATH propagation (RFC 4271)', () => {
  /** A(65001) — B(65002) — C(65003), each originating one prefix. */
  function chain() {
    const a = router('A', 65001, '192.168.1.0');
    const b = router('B', 65002, '192.168.2.0');
    const c = router('C', 65003, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65002); neighbor(b, '10.0.12.1', 65001);
    neighbor(b, '10.0.23.2', 65003); neighbor(c, '10.0.23.1', 65002);
    mesh([[a, '10.0.12.1', b, '10.0.12.2'], [b, '10.0.23.1', c, '10.0.23.2']]);
    a.converge(); b.converge(); c.converge();
    return { a, b, c };
  }

  it('propagates a prefix transitively across two AS hops', () => {
    const { a } = chain();
    const routes = a.getContributedRoutes();
    const nets = routes.map((r) => String(r.network)).sort();
    expect(nets).toEqual(['192.168.2.0', '192.168.3.0']);
    const toC = routes.find((r) => String(r.network) === '192.168.3.0')!;
    expect(String(toC.nextHop)).toBe('10.0.12.2'); // via the direct peer B
  });

  it('records the AS_PATH in propagation order', () => {
    const { a } = chain();
    const row = a.getBgpTable().find((r) => String(r.network) === '192.168.3.0')!;
    expect(row.asPath).toEqual([65002, 65003]);
    const direct = a.getBgpTable().find((r) => String(r.network) === '192.168.2.0')!;
    expect(direct.asPath).toEqual([65002]);
  });

  it('locally originated prefixes carry an empty path and weight 32768', () => {
    const { a } = chain();
    const own = a.getBgpTable().find((r) => String(r.network) === '192.168.1.0')!;
    expect(own.asPath).toEqual([]);
    expect(own.weight).toBe(32768);
  });

  it('rejects a route whose AS_PATH already contains the local ASN (loop prevention)', () => {
    const a = router('A', 65001, '192.168.1.0');
    const b = router('B', 65002, '192.168.2.0');
    const c = router('C', 65003, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65002); neighbor(b, '10.0.12.1', 65001);
    neighbor(b, '10.0.23.2', 65003); neighbor(c, '10.0.23.1', 65002);
    neighbor(c, '10.0.31.2', 65001); neighbor(a, '10.0.31.1', 65003);
    mesh([
      [a, '10.0.12.1', b, '10.0.12.2'],
      [b, '10.0.23.1', c, '10.0.23.2'],
      [c, '10.0.31.1', a, '10.0.31.2'],
    ]);
    a.converge(); b.converge(); c.converge();
    const nets = a.getContributedRoutes().map((r) => String(r.network));
    expect(nets).not.toContain('192.168.1.0');
    expect(nets.sort()).toEqual(['192.168.2.0', '192.168.3.0']);
  });

  it('prefers the shortest AS_PATH between two paths to the same prefix', () => {
    const a = router('A', 65001, '192.168.1.0');
    const b = router('B', 65002, '192.168.2.0');
    const c = router('C', 65003, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65002); neighbor(b, '10.0.12.1', 65001);
    neighbor(b, '10.0.23.2', 65003); neighbor(c, '10.0.23.1', 65002);
    neighbor(c, '10.0.31.2', 65001); neighbor(a, '10.0.31.1', 65003);
    mesh([
      [a, '10.0.12.1', b, '10.0.12.2'],
      [b, '10.0.23.1', c, '10.0.23.2'],
      [c, '10.0.31.1', a, '10.0.31.2'],
    ]);
    a.converge(); b.converge(); c.converge();
    const row = a.getBgpTable().find((r) => String(r.network) === '192.168.3.0')!;
    expect(row.asPath).toEqual([65003]);
    const rib = a.getContributedRoutes().find((r) => String(r.network) === '192.168.3.0')!;
    expect(String(rib.nextHop)).toBe('10.0.31.1'); // C's address on the A-C link
  });

  it('iBGP split-horizon: a route learned from an iBGP peer is not re-advertised to another iBGP peer', () => {
    const a = router('A', 65000, '192.168.1.0');
    const b = router('B', 65000, '192.168.2.0');
    const c = router('C', 65000, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65000); neighbor(b, '10.0.12.1', 65000);
    neighbor(b, '10.0.23.2', 65000); neighbor(c, '10.0.23.1', 65000);
    mesh([[a, '10.0.12.1', b, '10.0.12.2'], [b, '10.0.23.1', c, '10.0.23.2']]);
    a.converge(); b.converge(); c.converge();
    expect(b.getContributedRoutes().map((r) => String(r.network)).sort())
      .toEqual(['192.168.1.0', '192.168.3.0']);
    expect(a.getContributedRoutes().map((r) => String(r.network)))
      .toEqual(['192.168.2.0']);
  });

  it('eBGP prefix crossing an AS keeps the full path through it', () => {
    const a = router('A', 65001, '192.168.1.0');
    const b = router('B', 65002, '192.168.2.0');
    const c = router('C', 65001, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65002); neighbor(b, '10.0.12.1', 65001);
    neighbor(b, '10.0.23.2', 65001); neighbor(c, '10.0.23.1', 65002);
    mesh([[a, '10.0.12.1', b, '10.0.12.2'], [b, '10.0.23.1', c, '10.0.23.2']]);
    a.converge(); b.converge(); c.converge();
    const nets = c.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.2.0');
    expect(nets).not.toContain('192.168.1.0'); // own ASN in path → rejected
  });
});
