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
import { PolicyRepository } from '@/network/devices/inspection/config/PolicyRepository';

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

function ctxMulti(nets: string[]) {
  return {
    connectedNetworks: () => nets.map((net) => ({
      network: new IPAddress(net),
      mask: new SubnetMask('255.255.255.0'),
      iface: 'Gi0/1',
      localIp: new IPAddress(net.replace(/0$/, '1')),
    })),
  };
}

function withPolicy(base: ReturnType<typeof ctxMulti>, policy: PolicyRepository) {
  return {
    ...base,
    evaluatePrefixList: (name: string, network: string, prefixLength: number) =>
      policy.evaluatePrefixList(name, network, prefixLength),
    evaluateRouteMap: (name: string, network: string, prefixLength: number) =>
      policy.evaluateRouteMap(name, network, prefixLength),
  };
}

describe('BGPEngine — neighbor prefix-list filtering (Cisco `neighbor <ip> prefix-list <name> in|out`)', () => {
  it('prefixListIn only accepts the prefixes the named list permits; a non-matching prefix is an implicit deny', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    policy.addPrefix('ALLOWED', { seq: 5, action: 'permit', prefix: '192.168.2.0/24' });
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0', '192.168.3.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', {
      ip: '10.0.0.2', remoteAs: 65002, activated: true, prefixListIn: 'ALLOWED',
    });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    r2.getConfig().networks.push({ network: '192.168.3.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r1.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.2.0');
    expect(nets).not.toContain('192.168.3.0');
  });

  it('prefixListOut only advertises the prefixes the named list permits', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    policy.addPrefix('EXPORT', { seq: 5, action: 'permit', prefix: '192.168.1.0/24' });
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0', '192.168.4.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', {
      ip: '10.0.0.2', remoteAs: 65002, activated: true, prefixListOut: 'EXPORT',
    });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r1.getConfig().networks.push({ network: '192.168.4.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r2.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.1.0');
    expect(nets).not.toContain('192.168.4.0');
  });

  it('a prefix-list name that does not exist is an implicit deny for every prefix', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository(); // NOSUCHLIST never defined
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', {
      ip: '10.0.0.2', remoteAs: 65002, activated: true, prefixListIn: 'NOSUCHLIST',
    });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    expect(r1.getContributedRoutes()).toHaveLength(0);
  });

  it('no prefix-list configured on the neighbor ⇒ unfiltered, same as before this feature', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    policy.addPrefix('UNRELATED', { seq: 5, action: 'permit', prefix: '10.10.10.0/24' });
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r1.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.2.0');
  });
});

describe('PolicyRepository — evaluatePrefixList', () => {
  it('permits/denies by first applicable match in seq order', () => {
    const p = new PolicyRepository();
    // `le 32` makes the deny cover every subnet of 10.0.0.0/8, not just an exact /8 match.
    p.addPrefix('L1', { seq: 5, action: 'deny', prefix: '10.0.0.0/8', le: 32 });
    p.addPrefix('L1', { seq: 10, action: 'permit', prefix: '10.1.0.0/16' });
    expect(p.evaluatePrefixList('L1', '10.1.0.0', 16)).toBe('deny'); // seq 5 (broader) matches first
    expect(p.evaluatePrefixList('L1', '10.2.0.0', 16)).toBe('deny');
    expect(p.evaluatePrefixList('L1', '192.168.0.0', 24)).toBeNull();
  });

  it('an entry with no ge/le requires an exact prefix-length match', () => {
    const p = new PolicyRepository();
    p.addPrefix('L3', { seq: 5, action: 'permit', prefix: '10.0.0.0/8' });
    expect(p.evaluatePrefixList('L3', '10.0.0.0', 8)).toBe('permit');
    expect(p.evaluatePrefixList('L3', '10.1.0.0', 16)).toBeNull(); // /16 subnet, not an exact /8
  });

  it('honours ge/le range bounds', () => {
    const p = new PolicyRepository();
    p.addPrefix('L2', { seq: 5, action: 'permit', prefix: '10.0.0.0/8', ge: 24, le: 30 });
    expect(p.evaluatePrefixList('L2', '10.1.1.0', 24)).toBe('permit');
    expect(p.evaluatePrefixList('L2', '10.1.1.0', 16)).toBeNull(); // below ge
    expect(p.evaluatePrefixList('L2', '10.1.1.0', 31)).toBeNull(); // above le
  });

  it('an unknown list name returns null (caller treats as implicit deny)', () => {
    const p = new PolicyRepository();
    expect(p.evaluatePrefixList('NOPE', '10.0.0.0', 8)).toBeNull();
  });
});

describe('PolicyRepository — evaluateRouteMap', () => {
  it('a permit clause with no match statement matches unconditionally and carries its parsed set clauses', () => {
    const p = new PolicyRepository();
    const c = p.ensureRouteMap('RM1', 'permit', 10);
    c.set.push('set weight 500', 'set local-preference 300', 'set metric 20', 'set as-path prepend 65001 65001');
    const result = p.evaluateRouteMap('RM1', '10.0.0.0', 24);
    expect(result).toEqual({
      action: 'permit',
      set: { weight: 500, localPreference: 300, metric: 20, asPathPrepend: [65001, 65001] },
    });
  });

  it('a deny clause carries no set clauses even if some are configured', () => {
    const p = new PolicyRepository();
    const c = p.ensureRouteMap('RM2', 'deny', 10);
    c.set.push('set weight 999');
    expect(p.evaluateRouteMap('RM2', '10.0.0.0', 24)).toEqual({ action: 'deny', set: {} });
  });

  it('match ip address prefix-list gates which clause applies', () => {
    const p = new PolicyRepository();
    p.addPrefix('ONLY10', { seq: 5, action: 'permit', prefix: '10.0.0.0/8', le: 32 });
    const c = p.ensureRouteMap('RM3', 'permit', 10);
    c.match.push('match ip address prefix-list ONLY10');
    expect(p.evaluateRouteMap('RM3', '10.1.1.0', 24)?.action).toBe('permit');
    expect(p.evaluateRouteMap('RM3', '192.168.1.0', 24)).toBeNull(); // no clause matches -> implicit deny
  });

  it('an unknown route-map name returns null', () => {
    const p = new PolicyRepository();
    expect(p.evaluateRouteMap('NOPE', '10.0.0.0', 8)).toBeNull();
  });
});

describe('BGPEngine — neighbor route-map filtering + set clauses', () => {
  it('routeMapIn applies set weight/local-preference to accepted routes', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    const clause = policy.ensureRouteMap('IN', 'permit', 10);
    clause.set.push('set weight 500', 'set local-preference 300');
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', {
      ip: '10.0.0.2', remoteAs: 65002, activated: true, routeMapIn: 'IN',
    });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const row = r1.getBgpTable().find((r) => String(r.network) === '192.168.2.0');
    expect(row?.weight).toBe(500);
    expect(row?.localPref).toBe(300);
  });

  it('routeMapIn denies a prefix the route-map has no permitting clause for', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    policy.addPrefix('ONLY2', { seq: 5, action: 'permit', prefix: '192.168.2.0/24' });
    const clause = policy.ensureRouteMap('IN', 'permit', 10);
    clause.match.push('match ip address prefix-list ONLY2');
    r1.setDeviceContext(withPolicy(ctxMulti(['192.168.1.0']), policy));
    r2.setDeviceContext(ctxMulti(['192.168.2.0', '192.168.3.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true, routeMapIn: 'IN' });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    r2.getConfig().networks.push({ network: '192.168.3.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r1.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.2.0');
    expect(nets).not.toContain('192.168.3.0');
  });

  it("routeMapOut's set as-path prepend is observable in the receiving peer's learned AS_PATH", () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    const policy = new PolicyRepository();
    const clause = policy.ensureRouteMap('OUT', 'permit', 10);
    clause.set.push('set as-path prepend 65002 65002');
    r2.setDeviceContext(withPolicy(ctxMulti(['192.168.2.0']), policy));
    r1.setDeviceContext(ctxMulti(['192.168.1.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', {
      ip: '10.0.0.1', remoteAs: 65001, activated: true, routeMapOut: 'OUT',
    });
    r2.getConfig().networks.push({ network: '192.168.2.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const row = r1.getBgpTable().find((r) => String(r.network) === '192.168.2.0');
    expect(row?.asPath).toEqual([65002, 65002, 65002]); // 2 prepended + the real origin ASN
  });

  it("routeMapOut's set metric changes best-path selection between two paths from the same neighboring AS", () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2'); // no route-map -> MED stays default 0
    const r3 = new BGPEngine('R3'); // route-map raises its own MED to 100
    const policy = new PolicyRepository();
    const clause = policy.ensureRouteMap('RAISEMED', 'permit', 10);
    clause.set.push('set metric 100');
    r1.setDeviceContext(ctxMulti(['192.168.1.0']));
    r2.setDeviceContext(ctxMulti(['192.168.9.0']));
    r3.setDeviceContext(withPolicy(ctxMulti(['192.168.9.0']), policy));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r2.getConfig().routerId = '9.9.9.9'; // higher router-id: would LOSE a tie-break at equal MED
    r3.enable({ asn: 65002 });
    r3.getConfig().routerId = '1.1.1.1'; // lower router-id: would WIN a tie-break at equal MED
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r1.getConfig().neighbors.set('10.0.0.3', { ip: '10.0.0.3', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    r3.getConfig().neighbors.set('10.0.0.1', {
      ip: '10.0.0.1', remoteAs: 65001, activated: true, routeMapOut: 'RAISEMED',
    });
    r2.getConfig().networks.push({ network: '192.168.9.0', mask: '255.255.255.0' });
    r3.getConfig().networks.push({ network: '192.168.9.0', mask: '255.255.255.0' });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    link(r1, '10.0.0.1', r3, '10.0.0.3');
    r1.converge(); r2.converge(); r3.converge();

    // R2 (MED 0, higher router-id) must beat R3 (MED 100, lower router-id) --
    // if `set metric` weren't actually applied, both would tie at MED 0 and
    // R3's lower router-id would win instead, so this is feature-proving.
    const routes = r1.getContributedRoutes().filter((r) => String(r.network) === '192.168.9.0');
    expect(routes).toHaveLength(1);
    expect(String(routes[0].nextHop)).toBe('10.0.0.2');
  });
});

describe('BGPEngine — aggregate-address', () => {
  it('originates the aggregate only once a covering more-specific route exists in Loc-RIB', () => {
    const r1 = new BGPEngine('R1');
    r1.setDeviceContext(ctxMulti(['10.1.1.0']));
    r1.enable({ asn: 65001 });
    r1.getConfig().networks.push({ network: '10.1.1.0', mask: '255.255.255.0' });
    r1.converge();
    expect(r1.getBgpTable().some((r) => String(r.network) === '10.1.0.0')).toBe(false);

    r1.getConfig().aggregates.push({ network: '10.1.0.0', mask: '255.255.0.0', summaryOnly: false });
    r1.converge();
    const agg = r1.getBgpTable().find((r) => String(r.network) === '10.1.0.0');
    expect(agg).toBeDefined();
    expect(agg!.asPath).toEqual([]);
  });

  it('without summary-only, advertises both the aggregate and its more-specifics', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctxMulti(['10.1.1.0', '10.1.2.0']));
    r2.setDeviceContext(ctxMulti(['192.168.9.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().networks.push({ network: '10.1.1.0', mask: '255.255.255.0' });
    r1.getConfig().networks.push({ network: '10.1.2.0', mask: '255.255.255.0' });
    r1.getConfig().aggregates.push({ network: '10.1.0.0', mask: '255.255.0.0', summaryOnly: false });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r2.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('10.1.1.0');
    expect(nets).toContain('10.1.2.0');
    expect(nets).toContain('10.1.0.0');
  });

  it('summary-only suppresses the covering more-specifics, advertising only the aggregate', () => {
    const r1 = new BGPEngine('R1');
    const r2 = new BGPEngine('R2');
    r1.setDeviceContext(ctxMulti(['10.1.1.0', '10.1.2.0']));
    r2.setDeviceContext(ctxMulti(['192.168.9.0']));
    r1.enable({ asn: 65001 });
    r2.enable({ asn: 65002 });
    r1.getConfig().networks.push({ network: '10.1.1.0', mask: '255.255.255.0' });
    r1.getConfig().networks.push({ network: '10.1.2.0', mask: '255.255.255.0' });
    r1.getConfig().aggregates.push({ network: '10.1.0.0', mask: '255.255.0.0', summaryOnly: true });
    r1.getConfig().neighbors.set('10.0.0.2', { ip: '10.0.0.2', remoteAs: 65002, activated: true });
    r2.getConfig().neighbors.set('10.0.0.1', { ip: '10.0.0.1', remoteAs: 65001, activated: true });
    link(r1, '10.0.0.1', r2, '10.0.0.2');
    r1.converge(); r2.converge();

    const nets = r2.getContributedRoutes().map((r) => String(r.network));
    expect(nets).not.toContain('10.1.1.0');
    expect(nets).not.toContain('10.1.2.0');
    expect(nets).toContain('10.1.0.0');
  });

  it('an aggregate with no covering more-specific route is never originated', () => {
    const r1 = new BGPEngine('R1');
    r1.setDeviceContext(ctxMulti(['192.168.1.0']));
    r1.enable({ asn: 65001 });
    r1.getConfig().networks.push({ network: '192.168.1.0', mask: '255.255.255.0' });
    r1.getConfig().aggregates.push({ network: '10.1.0.0', mask: '255.255.0.0', summaryOnly: false });
    r1.converge();

    expect(r1.getBgpTable().some((r) => String(r.network) === '10.1.0.0')).toBe(false);
  });
});
