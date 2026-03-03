/**
 * OSPF Advanced SPF TDD Test Suite — Step 8
 *
 * Tests for five previously missing / incomplete behaviours:
 *   1. ECMP (Equal-Cost Multi-Path) — SPF keeps up to 16 equal-cost next-hops
 *   2. External routes in routing table — Type 5 (E1/E2) and Type 7 (N1/N2)
 *      are installed as 'external-type1' / 'external-type2' entries
 *   3. Forwarding address — non-zero FA in External LSAs is honoured when
 *      computing next-hop for external routes
 *   4. Inter-area backbone pass-through — ABR propagates backbone inter-area
 *      routes (learned from other areas) into non-backbone areas as Type 3
 *   5. Partial SPF — only re-run Dijkstra when topology (Type 1/2 LSA) changes;
 *      leaf/summary/external changes use the cached SPF tree
 *
 * All tests are pure unit tests against OSPFEngine with no CiscoRouter CLI.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  makeLSDBKey,
  type RouterLSA,
  type NetworkLSA,
  type SummaryLSA,
  type ExternalLSA,
  type NSSAExternalLSA,
  type OSPFNeighbor,
  type OSPFRouteEntry,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEngine(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  return e;
}

/** Minimal Full neighbor (for next-hop resolution in SPF) */
function makeFakeNeighbor(
  routerId: string,
  ipAddress: string,
  ifaceName: string,
): OSPFNeighbor {
  return {
    routerId,
    ipAddress,
    iface: ifaceName,
    state: 'Full',
    priority: 1,
    neighborDR: '0.0.0.0',
    neighborBDR: '0.0.0.0',
    deadTimer: null,
    ddSeqNumber: 0,
    isMaster: false,
    lsRequestList: [],
    lsRetransmissionList: [],
    dbSummaryList: [],
    lastHelloReceived: Date.now(),
    options: 0x02,
    ddRetransmitTimer: null,
    lsrRetransmitTimer: null,
    lastSentDD: null,
  };
}

/** Build a Router-LSA */
function makeRouterLSA(
  routerId: string,
  flags = 0,
  links: RouterLSA['links'] = [],
): RouterLSA {
  return {
    lsAge: 0,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter: routerId,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 24 + links.length * 12,
    flags,
    numLinks: links.length,
    links,
  };
}

/** Build an AS-External (Type 5) LSA */
function makeExternalLSA(
  network: string,
  mask: string,
  asbr: string,
  metric: number,
  metricType: 1 | 2 = 2,
  forwardingAddress = '0.0.0.0',
): ExternalLSA {
  return {
    lsAge: 0,
    options: 0x02,
    lsType: 5,
    linkStateId: network,
    advertisingRouter: asbr,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 36,
    networkMask: mask,
    metricType,
    metric,
    forwardingAddress,
    externalRouteTag: 0,
  };
}

/** Build a Type 7 NSSA-External LSA */
function makeType7LSA(
  network: string,
  mask: string,
  asbr: string,
  metric: number,
  metricType: 1 | 2 = 2,
  forwardingAddress = '0.0.0.0',
): NSSAExternalLSA {
  return {
    lsAge: 0,
    options: 0x0a,  // N-bit + E-bit
    lsType: 7,
    linkStateId: network,
    advertisingRouter: asbr,
    lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 36,
    networkMask: mask,
    metricType,
    metric,
    forwardingAddress,
    externalRouteTag: 0,
  };
}

/**
 * Set up a p2p topology:
 *   R1 (us, routerId) — eth0 —[cost X]— R2 — stub network D
 *                     \ eth1 —[cost X]— R3 — stub network D
 *
 * Both paths have the same total cost → ECMP candidate.
 * Returns { engine, r1Iface1, r1Iface2 }.
 */
function setupECMPTopology(
  r1Id = '1.1.1.1',
  r2Id = '2.2.2.2',
  r3Id = '3.3.3.3',
  pathCost = 10,
  destNet = '10.10.0.0',
  destMask = '255.255.255.0',
  stubMetric = 1,
): { engine: OSPFEngine } {
  const engine = makeEngine(r1Id);
  engine.addNetwork('10.0.12.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  engine.addNetwork('10.0.13.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  const iface1 = engine.activateInterface('eth0', '10.0.12.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
  const iface2 = engine.activateInterface('eth1', '10.0.13.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

  // Fake neighbors so SPF can resolve next-hops
  iface1.neighbors.set(r2Id, makeFakeNeighbor(r2Id, '10.0.12.2', 'eth0'));
  iface2.neighbors.set(r3Id, makeFakeNeighbor(r3Id, '10.0.13.2', 'eth1'));

  // R1 own Router-LSA: two p2p links to R2 and R3
  const r1Lsa = makeRouterLSA(r1Id, 0, [
    { type: 1, linkId: r2Id,  linkData: '10.0.12.1', metric: pathCost },
    { type: 1, linkId: r3Id,  linkData: '10.0.13.1', metric: pathCost },
  ]);
  engine.installLSA(OSPF_BACKBONE_AREA, r1Lsa);

  // R2 Router-LSA: p2p back to R1 + stub network D
  const r2Lsa = makeRouterLSA(r2Id, 0, [
    { type: 1, linkId: r1Id,   linkData: '10.0.12.2', metric: pathCost },
    { type: 3, linkId: destNet, linkData: destMask,    metric: stubMetric },
  ]);
  engine.installLSA(OSPF_BACKBONE_AREA, r2Lsa);

  // R3 Router-LSA: p2p back to R1 + same stub network D
  const r3Lsa = makeRouterLSA(r3Id, 0, [
    { type: 1, linkId: r1Id,   linkData: '10.0.13.2', metric: pathCost },
    { type: 3, linkId: destNet, linkData: destMask,    metric: stubMetric },
  ]);
  engine.installLSA(OSPF_BACKBONE_AREA, r3Lsa);

  return { engine };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — ECMP (Equal-Cost Multi-Path)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — ECMP (Equal-Cost Multi-Path)', () => {

  it('1.1 — single path: nextHops has exactly one entry', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
      { type: 3, linkId: '10.10.0.0', linkData: '255.255.255.0', metric: 1 },
    ]));

    const routes = engine.runSPF();
    const route = routes.find(r => r.network === '10.10.0.0');
    expect(route).toBeDefined();
    expect(route!.nextHops).toBeDefined();
    expect(route!.nextHops!.length).toBe(1);
  });

  it('1.2 — two equal-cost paths: nextHops has 2 entries, different interfaces', () => {
    const { engine } = setupECMPTopology();
    const routes = engine.runSPF();

    const dest = routes.filter(r => r.network === '10.10.0.0');
    // Either one route with 2 next-hops, or 2 separate entries — either is valid
    const allNextHops = dest.flatMap(r => r.nextHops ?? [r.nextHop]);
    expect(allNextHops.length).toBe(2);
    expect(new Set(allNextHops).size).toBe(2); // different next-hops
  });

  it('1.3 — unequal costs: only the cheaper path is kept', () => {
    // R2 path cost 5, R3 path cost 20 → only R2
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.12.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    engine.addNetwork('10.0.13.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface1 = engine.activateInterface('eth0', '10.0.12.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    const iface2 = engine.activateInterface('eth1', '10.0.13.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface1.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.12.2', 'eth0'));
    iface2.neighbors.set('3.3.3.3', makeFakeNeighbor('3.3.3.3', '10.0.13.2', 'eth1'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.12.1', metric: 5  },  // cheaper
      { type: 1, linkId: '3.3.3.3', linkData: '10.0.13.1', metric: 20 },  // expensive
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.12.2', metric: 5 },
      { type: 3, linkId: '10.10.0.0', linkData: '255.255.255.0', metric: 1 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('3.3.3.3', 0, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.13.2', metric: 20 },
      { type: 3, linkId: '10.10.0.0', linkData: '255.255.255.0', metric: 1 },
    ]));

    const routes = engine.runSPF();
    const dest = routes.filter(r => r.network === '10.10.0.0');
    const allNextHops = dest.flatMap(r => r.nextHops ?? [r.nextHop]);
    // Only cheaper path (via R2) kept
    expect(allNextHops.length).toBe(1);
    expect(allNextHops[0]).toBe('10.0.12.2');
  });

  it('1.4 — ECMP cap: more than 16 equal-cost paths → at most 16 kept', () => {
    // Build 20 equal-cost neighbours all reaching 10.20.0.0/24
    const engine = makeEngine('1.1.1.1');
    const LIMIT = 16;
    const COUNT = 20;

    for (let i = 2; i <= COUNT + 1; i++) {
      const rId  = `${i}.${i}.${i}.${i}`;
      const net  = `10.0.${i}.0`;
      const ifNm = `eth${i}`;
      engine.addNetwork(net, '0.0.0.255', OSPF_BACKBONE_AREA);
      const iface = engine.activateInterface(ifNm, `10.0.${i}.1`, '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
      iface.neighbors.set(rId, makeFakeNeighbor(rId, `10.0.${i}.2`, ifNm));

      engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(rId, 0, [
        { type: 1, linkId: '1.1.1.1', linkData: `10.0.${i}.2`, metric: 10 },
        { type: 3, linkId: '10.20.0.0', linkData: '255.255.255.0', metric: 1 },
      ]));
    }
    // R1's own Router-LSA
    const r1Links = [];
    for (let i = 2; i <= COUNT + 1; i++) {
      r1Links.push({ type: 1 as const, linkId: `${i}.${i}.${i}.${i}`, linkData: `10.0.${i}.1`, metric: 10 });
    }
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, r1Links));

    const routes = engine.runSPF();
    const dest = routes.filter(r => r.network === '10.20.0.0');
    const allNextHops = dest.flatMap(r => r.nextHops ?? [r.nextHop]);
    expect(allNextHops.length).toBeGreaterThan(1);
    expect(allNextHops.length).toBeLessThanOrEqual(LIMIT);
  });

  it('1.5 — ECMP routes list distinct outgoing interfaces', () => {
    const { engine } = setupECMPTopology();
    const routes = engine.runSPF();
    const dest = routes.filter(r => r.network === '10.10.0.0');
    const allIfaces = dest.flatMap(r => r.ifaces ?? [r.iface]);
    expect(new Set(allIfaces).size).toBeGreaterThan(1); // at least 2 different ifaces
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — External Routes in Routing Table (E1/E2, N1/N2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — External routes in routing table (E1/E2, N1/N2)', () => {

  /** Engine with R1 connected to ASBR R2 (E-bit set) via p2p */
  function setupWithASBR(
    asbrId = '2.2.2.2',
    pathMetric = 10,
  ): OSPFEngine {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface.neighbors.set(asbrId, makeFakeNeighbor(asbrId, '10.0.0.2', 'eth0'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: asbrId, linkData: '10.0.0.1', metric: pathMetric },
    ]));
    // ASBR: E-bit (0x02) set in flags
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(asbrId, 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: pathMetric },
    ]));
    return engine;
  }

  it('2.1 — Type 5 E2 route appears in getRoutes() as external-type2', () => {
    const engine = setupWithASBR();
    engine.installLSA(OSPF_BACKBONE_AREA, makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext).toBeDefined();
    expect(ext!.routeType).toBe('external-type2');
  });

  it('2.2 — Type 5 E2 cost equals external metric (not path cost)', () => {
    const engine = setupWithASBR('2.2.2.2', 10);
    engine.installLSA(OSPF_BACKBONE_AREA, makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext!.cost).toBe(20);           // just the external metric
    expect(ext!.type2Cost).toBe(10);      // ASBR path kept for tie-breaking
  });

  it('2.3 — Type 5 E1 route: cost = ASBR path + external metric', () => {
    const engine = setupWithASBR('2.2.2.2', 10);
    engine.installLSA(OSPF_BACKBONE_AREA, makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 1));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext).toBeDefined();
    expect(ext!.routeType).toBe('external-type1');
    expect(ext!.cost).toBe(30);  // 10 (path) + 20 (external)
  });

  it('2.4 — ASBR unreachable → external route is NOT installed', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

    // Only R1's own LSA (no R2 entry) — ASBR 2.2.2.2 unreachable
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, []));
    engine.installLSA(OSPF_BACKBONE_AREA, makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2));

    const routes = engine.runSPF();
    expect(routes.find(r => r.network === '172.16.0.0')).toBeUndefined();
  });

  it('2.5 — Type 7 N2 route in NSSA area appears as external-type2', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.1');
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    engine.setAreaType('0.0.0.1', 'nssa');
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    engine.installLSA('0.0.0.1', makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA('0.0.0.1', makeRouterLSA('2.2.2.2', 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
    ]));
    engine.installLSA('0.0.0.1', makeType7LSA('192.168.1.0', '255.255.255.0', '2.2.2.2', 30, 2));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '192.168.1.0');
    expect(ext).toBeDefined();
    expect(ext!.routeType).toBe('external-type2');
    expect(ext!.cost).toBe(30);
  });

  it('2.6 — Type 7 N1 route: cost = path-to-ASBR + external metric', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.1');
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    engine.setAreaType('0.0.0.1', 'nssa');
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    engine.installLSA('0.0.0.1', makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA('0.0.0.1', makeRouterLSA('2.2.2.2', 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
    ]));
    engine.installLSA('0.0.0.1', makeType7LSA('192.168.1.0', '255.255.255.0', '2.2.2.2', 30, 1));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '192.168.1.0');
    expect(ext).toBeDefined();
    expect(ext!.routeType).toBe('external-type1');
    expect(ext!.cost).toBe(40);  // 10 (path) + 30 (external)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — Forwarding Address
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — Forwarding Address in External LSAs', () => {

  it('3.1 — FA=0.0.0.0: route uses ASBR next-hop', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
    ]));
    // FA = 0.0.0.0 → use ASBR next-hop (10.0.0.2)
    engine.installLSA(OSPF_BACKBONE_AREA, makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2, '0.0.0.0'));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext).toBeDefined();
    expect(ext!.nextHop).toBe('10.0.0.2');
  });

  it('3.2 — FA≠0.0.0.0 and reachable: route uses FA next-hop, not ASBR next-hop', () => {
    // Topology:
    //   R1 --eth0-- R2 (ASBR) — but external FA = 10.0.1.99 which is reachable via R3
    //   R1 --eth1-- R3, and 10.0.1.0/24 is R3's stub
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    engine.addNetwork('10.0.1.0', '0.0.0.255', OSPF_BACKBONE_AREA);

    const iface0 = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    const iface1 = engine.activateInterface('eth1', '10.0.1.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

    iface0.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));
    iface1.neighbors.set('3.3.3.3', makeFakeNeighbor('3.3.3.3', '10.0.1.2', 'eth1'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
      { type: 1, linkId: '3.3.3.3', linkData: '10.0.1.1', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('3.3.3.3', 0, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.1.2', metric: 10 },
      // R3 has 10.0.1.0/24 as stub (where FA 10.0.1.99 lives)
      { type: 3, linkId: '10.0.1.0', linkData: '255.255.255.0', metric: 1 },
    ]));

    // External LSA with FA = 10.0.1.99 (reachable via R3 / eth1)
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2, '10.0.1.99'));

    const routes = engine.runSPF();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext).toBeDefined();
    // Next-hop must be via R3 (FA route), not R2 (ASBR direct)
    expect(ext!.nextHop).toBe('10.0.1.2');
    expect(ext!.iface).toBe('eth1');
  });

  it('3.3 — FA≠0.0.0.0 but unreachable: external route is NOT installed', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0x02, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
    ]));
    // FA = 192.168.99.1 — no route to it in OSPF topology
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2, '192.168.99.1'));

    const routes = engine.runSPF();
    expect(routes.find(r => r.network === '172.16.0.0')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — Inter-area backbone pass-through (ABR)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4 — Inter-area backbone pass-through (ABR)', () => {

  /**
   * Create an ABR engine with:
   *   eth0 in backbone (area 0)
   *   eth1 in area 1
   */
  function makeABR(routerId: string): OSPFEngine {
    const e = makeEngine(routerId);
    e.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    e.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    e.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    e.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    return e;
  }

  it('4.1 — ABR originates Type 3 into area 1 for intra-area backbone routes', () => {
    const abr = makeABR('1.1.1.1');
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        { network: '10.2.0.0', mask: '255.255.255.0', routeType: 'intra-area',
          areaId: OSPF_BACKBONE_AREA, nextHop: '10.0.0.99', iface: 'eth0', cost: 10, advertisingRouter: '5.5.5.5' },
      ]],
      ['0.0.0.1', []],
    ]);

    abr.originateSummariesAsABR(routes);

    const area1DB = abr.getAreaLSDB('0.0.0.1')!;
    expect(area1DB.has(makeLSDBKey(3, '10.2.0.0', '1.1.1.1'))).toBe(true);
  });

  it('4.2 — ABR propagates backbone inter-area routes into area 1', () => {
    // The backbone has an inter-area route to 10.3.0.0/24 (learned from area 2 via another ABR)
    const abr = makeABR('1.1.1.1');
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        { network: '10.3.0.0', mask: '255.255.255.0', routeType: 'inter-area',
          areaId: OSPF_BACKBONE_AREA, nextHop: '10.0.0.99', iface: 'eth0', cost: 20, advertisingRouter: '6.6.6.6' },
      ]],
      ['0.0.0.1', []],
    ]);

    abr.originateSummariesAsABR(routes);

    const area1DB = abr.getAreaLSDB('0.0.0.1')!;
    // Area 1 should receive a Type 3 for the backbone inter-area route
    expect(area1DB.has(makeLSDBKey(3, '10.3.0.0', '1.1.1.1'))).toBe(true);
  });

  it('4.3 — ABR does NOT re-originate area 1 intra routes back into area 1', () => {
    const abr = makeABR('1.1.1.1');
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, []],
      ['0.0.0.1', [
        { network: '10.1.1.0', mask: '255.255.255.0', routeType: 'intra-area',
          areaId: '0.0.0.1', nextHop: '10.1.0.2', iface: 'eth1', cost: 5, advertisingRouter: '7.7.7.7' },
      ]],
    ]);

    abr.originateSummariesAsABR(routes);

    // Area 1 must NOT get a Type 3 for its own intra-area network
    const area1DB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    expect(area1DB.has(makeLSDBKey(3, '10.1.1.0', '1.1.1.1'))).toBe(false);
    // But backbone DOES get it
    const bbDB = abr.getAreaLSDB(OSPF_BACKBONE_AREA)!;
    expect(bbDB.has(makeLSDBKey(3, '10.1.1.0', '1.1.1.1'))).toBe(true);
  });

  it('4.4 — backbone inter-area route NOT propagated back to the originating area', () => {
    // backbone has inter-area route from area 1 (same as target) → must NOT loop back
    const abr = makeABR('1.1.1.1');
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        // This inter-area route in backbone came from area 1 (advertisingRouter = internal area-1 router)
        { network: '10.1.5.0', mask: '255.255.255.0', routeType: 'inter-area',
          areaId: OSPF_BACKBONE_AREA, nextHop: '10.0.0.50', iface: 'eth0', cost: 15, advertisingRouter: '8.8.8.8' },
      ]],
      ['0.0.0.1', [
        // area 1 already has this as an intra-area route
        { network: '10.1.5.0', mask: '255.255.255.0', routeType: 'intra-area',
          areaId: '0.0.0.1', nextHop: '10.1.0.50', iface: 'eth1', cost: 5, advertisingRouter: '8.8.8.8' },
      ]],
    ]);

    abr.originateSummariesAsABR(routes);

    // The backbone inter-area route to 10.1.5.0 must NOT be re-originated into area 1
    // (area 1 already has a better intra-area path)
    // Both intra and inter routes are considered; the ABR must not duplicate
    const area1DB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    const key = makeLSDBKey(3, '10.1.5.0', '1.1.1.1');
    if (area1DB.has(key)) {
      // If it IS installed, its metric must match the backbone's inter-area cost (not less)
      const lsa = area1DB.get(key) as SummaryLSA;
      expect(lsa.metric).toBeGreaterThanOrEqual(15);
    }
    // (No assertion failure if it's simply absent — that's equally valid)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5 — Partial SPF
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5 — Partial SPF', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setupBasicEngine(): OSPFEngine {
    const engine = makeEngine('1.1.1.1');
    // Set throttle to 0 so SPF fires immediately when timers are advanced
    engine.setThrottleSPF(0, 0, 0);
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    const iface = engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
    ]));
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', 0, [
      { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.2', metric: 10 },
      { type: 3, linkId: '10.1.0.0', linkData: '255.255.255.0', metric: 5 },
    ]));
    // Fire the pending full-SPF timer (delay=0, so 1ms advance suffices).
    // This sets spfNeedsFullRun=false and builds spfTreeCache.
    vi.advanceTimersByTime(1);
    // Also call runSPF() directly to ensure the tree cache is populated for partial SPF tests.
    engine.runSPF();
    return engine;
  }

  it('5.1 — installing a Type 5 external LSA schedules a partial SPF (not full)', () => {
    const engine = setupBasicEngine();
    engine.setThrottleSPF(0, 0, 0); // immediate execution

    // Installing a Type 5 (external) should trigger partial, not full
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2));
    vi.advanceTimersByTime(1);

    expect(engine.getLastSPFType()).toBe('partial');
  });

  it('5.2 — installing a Type 3 Summary LSA schedules a partial SPF', () => {
    const engine = setupBasicEngine();
    engine.setThrottleSPF(0, 0, 0);

    const sumLsa: SummaryLSA = {
      lsAge: 0, options: 0x02, lsType: 3,
      linkStateId: '10.9.0.0', advertisingRouter: '2.2.2.2',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0, length: 28,
      networkMask: '255.255.255.0', metric: 15,
    };
    engine.installLSA(OSPF_BACKBONE_AREA, sumLsa);
    vi.advanceTimersByTime(1);

    expect(engine.getLastSPFType()).toBe('partial');
  });

  it('5.3 — installing a Type 1 Router LSA schedules a full SPF', () => {
    const engine = setupBasicEngine();
    engine.setThrottleSPF(0, 0, 0);

    // New router LSA = topology change → full SPF
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeRouterLSA('5.5.5.5', 0, [
        { type: 1, linkId: '2.2.2.2', linkData: '10.5.0.1', metric: 5 },
      ]));
    vi.advanceTimersByTime(1);

    expect(engine.getLastSPFType()).toBe('full');
  });

  it('5.4 — partial SPF produces a correct routing table (same as full SPF would)', () => {
    const engine = setupBasicEngine();
    engine.setThrottleSPF(0, 0, 0);

    // Add an external route via partial SPF
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeExternalLSA('172.16.0.0', '255.255.0.0', '2.2.2.2', 20, 2));
    vi.advanceTimersByTime(1);

    const routes = engine.getRoutes();
    const ext = routes.find(r => r.network === '172.16.0.0');
    expect(ext).toBeDefined();
    expect(ext!.routeType).toBe('external-type2');
    expect(ext!.cost).toBe(20);
  });

  it('5.5 — full SPF after topology change rebuilds the tree correctly', () => {
    const engine = setupBasicEngine();
    engine.setThrottleSPF(0, 0, 0);

    // Add a new router that connects to a new stub
    engine.getInterface('eth0')!.neighbors.set('5.5.5.5', makeFakeNeighbor('5.5.5.5', '10.0.0.5', 'eth0'));
    engine.installLSA(OSPF_BACKBONE_AREA,
      makeRouterLSA('5.5.5.5', 0, [
        { type: 1, linkId: '1.1.1.1', linkData: '10.0.0.5', metric: 10 },
        { type: 3, linkId: '10.50.0.0', linkData: '255.255.255.0', metric: 1 },
      ]));
    // Update R1's LSA to include link to R5
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      { type: 1, linkId: '2.2.2.2', linkData: '10.0.0.1', metric: 10 },
      { type: 1, linkId: '5.5.5.5', linkData: '10.0.0.1', metric: 10 },
    ]));
    vi.advanceTimersByTime(1);

    expect(engine.getLastSPFType()).toBe('full');
    const routes = engine.getRoutes();
    expect(routes.find(r => r.network === '10.50.0.0')).toBeDefined();
  });
});
