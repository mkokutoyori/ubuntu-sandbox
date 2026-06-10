/**
 * TDD — real BGP engine. A session reaches Established only with a
 * genuinely cabled peer running BGP that points back reciprocally
 * with the right AS; otherwise Idle (no peer) / Active (peer, no
 * reciprocal). Routes learned only when Established. True state, no
 * fabricated "up".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BGPEngine } from '@/network/bgp/BGPEngine';
import type { RoutingPeer } from '@/network/routing';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';

beforeEach(() => resetCounters());

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

function link(a: BGPEngine, aIp: string, b: BGPEngine, bIp: string) {
  const mk = (eng: BGPEngine, localIp: string, remoteIp: string): RoutingPeer => ({
    deviceId: remoteIp, hostname: remoteIp,
    localIface: 'Gi0/0', localIp: new IPAddress(localIp),
    remoteIface: 'Gi0/0', remoteIp: new IPAddress(remoteIp),
    peerEngineFor: (p) => (p === 'bgp' ? eng : null),
  });
  a.setPeerLocator({ locatePeers: () => [mk(b, aIp, bIp)] });
  b.setPeerLocator({ locatePeers: () => [mk(a, bIp, aIp)] });
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

// ─── Transitive propagation, AS_PATH and loop prevention ────────────

/** Wire several point-to-point links; each engine gets ONE combined locator. */
function mesh(links: Array<[BGPEngine, string, BGPEngine, string]>) {
  const peersOf = new Map<BGPEngine, RoutingPeer[]>();
  const add = (eng: BGPEngine, peer: RoutingPeer) => {
    const list = peersOf.get(eng) ?? [];
    list.push(peer);
    peersOf.set(eng, list);
  };
  for (const [a, aIp, b, bIp] of links) {
    add(a, {
      deviceId: bIp, hostname: bIp,
      localIface: 'Gi0/0', localIp: new IPAddress(aIp),
      remoteIface: 'Gi0/0', remoteIp: new IPAddress(bIp),
      peerEngineFor: (proto) => (proto === 'bgp' ? b : null),
    });
    add(b, {
      deviceId: aIp, hostname: aIp,
      localIface: 'Gi0/0', localIp: new IPAddress(bIp),
      remoteIface: 'Gi0/0', remoteIp: new IPAddress(aIp),
      peerEngineFor: (proto) => (proto === 'bgp' ? a : null),
    });
  }
  for (const [eng, list] of peersOf) {
    eng.setPeerLocator({ locatePeers: () => list });
  }
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
    // Full triangle: every prefix has a 1-hop and a 2-hop path; the
    // 2-hop advert back to the originator contains its own ASN.
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
    // A must never re-learn its own prefix from B or C.
    const nets = a.getContributedRoutes().map((r) => String(r.network));
    expect(nets).not.toContain('192.168.1.0');
    expect(nets.sort()).toEqual(['192.168.2.0', '192.168.3.0']);
  });

  it('prefers the shortest AS_PATH between two paths to the same prefix', () => {
    // Triangle again: A reaches C's prefix directly (path [65003]) and
    // via B (path [65002 65003]); the direct path must win.
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
    a.converge();
    const row = a.getBgpTable().find((r) => String(r.network) === '192.168.3.0')!;
    expect(row.asPath).toEqual([65003]);
    const rib = a.getContributedRoutes().find((r) => String(r.network) === '192.168.3.0')!;
    expect(String(rib.nextHop)).toBe('10.0.31.1'); // C's address on the A-C link
  });

  it('iBGP split-horizon: a route learned from an iBGP peer is not re-advertised to another iBGP peer', () => {
    // A — B — C all in AS 65000, chain (no full mesh): C's prefix reaches
    // B but must NOT be relayed by B to A.
    const a = router('A', 65000, '192.168.1.0');
    const b = router('B', 65000, '192.168.2.0');
    const c = router('C', 65000, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65000); neighbor(b, '10.0.12.1', 65000);
    neighbor(b, '10.0.23.2', 65000); neighbor(c, '10.0.23.1', 65000);
    mesh([[a, '10.0.12.1', b, '10.0.12.2'], [b, '10.0.23.1', c, '10.0.23.2']]);
    a.converge(); b.converge();
    expect(b.getContributedRoutes().map((r) => String(r.network)).sort())
      .toEqual(['192.168.1.0', '192.168.3.0']);
    expect(a.getContributedRoutes().map((r) => String(r.network)))
      .toEqual(['192.168.2.0']);
  });

  it('eBGP prefix crossing an AS keeps the full path through it', () => {
    // A(65001) — B(65002) — C(65001): C sees its own ASN in the path
    // [65002, 65001, …] for A's prefix and rejects it.
    const a = router('A', 65001, '192.168.1.0');
    const b = router('B', 65002, '192.168.2.0');
    const c = router('C', 65001, '192.168.3.0');
    neighbor(a, '10.0.12.2', 65002); neighbor(b, '10.0.12.1', 65001);
    neighbor(b, '10.0.23.2', 65001); neighbor(c, '10.0.23.1', 65002);
    mesh([[a, '10.0.12.1', b, '10.0.12.2'], [b, '10.0.23.1', c, '10.0.23.2']]);
    c.converge();
    const nets = c.getContributedRoutes().map((r) => String(r.network));
    expect(nets).toContain('192.168.2.0');
    expect(nets).not.toContain('192.168.1.0'); // own ASN in path → rejected
  });
});
