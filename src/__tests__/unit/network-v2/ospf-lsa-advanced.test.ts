/**
 * OSPF Advanced LSA TDD Test Suite — Step 4
 *
 * Tests for the four previously missing features:
 *   1. Type 3 (Summary Network LSA) — ABR origination and inter-area routing
 *   2. Type 4 (Summary ASBR LSA)    — ABR signals ASBR reachability
 *   3. Type 7 (NSSA External LSA)   — ASBR generates Type 7; ABR translates → Type 5
 *   4. OSPFv3 Link-LSA (0x0008) and Intra-Area-Prefix-LSA (0x2009)
 *
 * All tests are pure unit tests against OSPFEngine / OSPFv3Engine with no
 * CiscoRouter CLI overhead.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  makeLSDBKey,
  type RouterLSA,
  type SummaryLSA,
  type ASBRSummaryLSA,
  type ExternalLSA,
  type NSSAExternalLSA,
  type OSPFNeighbor,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { OSPFv3Engine, OSPFV3_LSA_LINK, OSPFV3_LSA_INTRA_AREA_PREFIX } from '@/network/ospf/OSPFv3Engine';

/** Create a fake Full neighbor (for SPF next-hop resolution without Hello exchange) */
function makeFakeNeighbor(routerId: string, ipAddress: string, ifaceName: string): OSPFNeighbor {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create an OSPFEngine with a given router ID */
function makeEngine(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  return e;
}

/** Build a minimal Router-LSA with an optional E-bit (ASBR) */
function makeRouterLSA(
  routerId: string,
  flags: number = 0,
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

// ════════════════════════════════════════════════════════════════════════════
// GROUP 1 – Type 3 Summary Network LSA (ABR Origination)
// ════════════════════════════════════════════════════════════════════════════

describe('OSPF Type 3 Summary LSA – ABR origination', () => {

  it('1.01 – isABR() returns true when router has interfaces in multiple areas', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.0');
    engine.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', '0.0.0.0', { networkType: 'point-to-point' });
    engine.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    expect(engine.isABR()).toBe(true);
    engine.shutdown();
  });

  it('1.02 – isABR() returns false when router has interfaces in only one area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.0');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', '0.0.0.0', { networkType: 'point-to-point' });
    expect(engine.isABR()).toBe(false);
    engine.shutdown();
  });

  it('1.03 – originateSummaryLSA() creates a Type 3 LSA in the target area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    engine.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    engine.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    const lsa = engine.originateSummaryLSA('0.0.0.1', '10.0.0.0', '255.255.255.0', 10);
    expect(lsa.lsType).toBe(3);
    expect(lsa.linkStateId).toBe('10.0.0.0');
    expect(lsa.advertisingRouter).toBe('1.1.1.1');
    expect(lsa.networkMask).toBe('255.255.255.0');
    expect(lsa.metric).toBe(10);

    // Should be stored in area 0.0.0.1 LSDB
    const areaDB = engine.getAreaLSDB('0.0.0.1');
    expect(areaDB).toBeDefined();
    const key = makeLSDBKey(3, '10.0.0.0', '1.1.1.1');
    expect(areaDB!.has(key)).toBe(true);

    engine.shutdown();
  });

  it('1.04 – Summary LSA has correct length (28 bytes)', () => {
    const engine = makeEngine('1.1.1.1');
    engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    engine.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    engine.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    const lsa = engine.originateSummaryLSA('0.0.0.1', '192.168.0.0', '255.255.255.0', 20);
    // Type 3: 20-byte header + 4 (networkMask) + 4 (metric with padding) = 28
    expect(lsa.length).toBe(28);

    engine.shutdown();
  });

  it('1.05 – runSPF() on ABR auto-originates Type 3 LSAs for intra-area routes into other areas', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    // Add fake Full neighbor on eth1 (needed for SPF next-hop resolution)
    const eth1 = abr.getInterface('eth1')!;
    eth1.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.1.0.2', 'eth1'));

    // Install a Router-LSA from area 1 representing a remote network
    const remoteRouterLSA: RouterLSA = makeRouterLSA('2.2.2.2', 0, [
      {
        linkId: '10.1.1.0',
        linkData: '255.255.255.0',
        type: 3, // stub network
        numTOS: 0,
        metric: 5,
      },
    ]);
    abr.installLSA('0.0.0.1', remoteRouterLSA);

    // Also need the ABR's own Router-LSA in area 1 to anchor the SPF tree
    const abrLSA1: RouterLSA = makeRouterLSA('1.1.1.1', 0x01, [ // B-bit set
      {
        linkId: '2.2.2.2',
        linkData: '10.1.0.1',
        type: 1, // point-to-point
        numTOS: 0,
        metric: 1,
      },
    ]);
    abr.installLSA('0.0.0.1', abrLSA1);

    // Also need Router-LSA in backbone
    const abrLSA0: RouterLSA = makeRouterLSA('1.1.1.1', 0x01);
    abr.installLSA(OSPF_BACKBONE_AREA, abrLSA0);

    abr.runSPF();

    // After SPF, ABR should have originated a Type 3 Summary LSA for 10.1.1.0/24 into backbone
    const backboneDB = abr.getAreaLSDB(OSPF_BACKBONE_AREA);
    expect(backboneDB).toBeDefined();
    const summaryKey = makeLSDBKey(3, '10.1.1.0', '1.1.1.1');
    expect(backboneDB!.has(summaryKey)).toBe(true);

    const summaryLsa = backboneDB!.get(summaryKey) as SummaryLSA;
    expect(summaryLsa.lsType).toBe(3);
    expect(summaryLsa.networkMask).toBe('255.255.255.0');
    expect(summaryLsa.metric).toBeGreaterThanOrEqual(5); // intra cost + link cost

    abr.shutdown();
  });

  it('1.06 – runSPFForArea() produces inter-area routes from Type 3 LSAs in LSDB', () => {
    // R1 in backbone only; ABR (1.2.3.4) advertises Type 3 LSA for 192.168.1.0/24
    const r1 = makeEngine('1.1.1.1');
    r1.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    r1.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

    // Add fake Full neighbor 1.2.3.4 on eth0 (needed for SPF next-hop resolution)
    const eth0 = r1.getInterface('eth0')!;
    eth0.neighbors.set('1.2.3.4', makeFakeNeighbor('1.2.3.4', '10.0.0.2', 'eth0'));

    // Own Router-LSA for R1 in backbone
    r1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0, [
      {
        linkId: '1.2.3.4', linkData: '10.0.0.1',
        type: 1, numTOS: 0, metric: 1,
      },
    ]));

    // ABR's Router-LSA in backbone (B-bit set)
    r1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.2.3.4', 0x01, [
      {
        linkId: '1.1.1.1', linkData: '10.0.0.2',
        type: 1, numTOS: 0, metric: 1,
      },
    ]));

    // ABR originates Type 3 Summary LSA for 192.168.1.0/24 into backbone
    const summaryLsa: SummaryLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 3,
      linkStateId: '192.168.1.0',
      advertisingRouter: '1.2.3.4',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0,
      length: 28,
      networkMask: '255.255.255.0',
      metric: 5,
    };
    r1.installLSA(OSPF_BACKBONE_AREA, summaryLsa);

    const routes = r1.runSPF();
    const interAreaRoute = routes.find(rt => rt.network === '192.168.1.0' && rt.routeType === 'inter-area');
    expect(interAreaRoute).toBeDefined();
    expect(interAreaRoute!.mask).toBe('255.255.255.0');
    expect(interAreaRoute!.cost).toBeGreaterThanOrEqual(5);

    r1.shutdown();
  });

});

// ════════════════════════════════════════════════════════════════════════════
// GROUP 2 – Type 4 Summary ASBR LSA
// ════════════════════════════════════════════════════════════════════════════

describe('OSPF Type 4 Summary ASBR LSA', () => {

  it('2.01 – isASBR() returns true when redistributeConnected is enabled', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setRedistributeConnected(true);
    expect(engine.isASBR()).toBe(true);
  });

  it('2.02 – isASBR() returns true when redistributeStatic is enabled', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setRedistributeStatic(true);
    expect(engine.isASBR()).toBe(true);
  });

  it('2.03 – isASBR() returns true when defaultInformationOriginate is enabled', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setDefaultInformationOriginate(true);
    expect(engine.isASBR()).toBe(true);
  });

  it('2.04 – isASBR() returns false when no redistribution is configured', () => {
    const engine = makeEngine('1.1.1.1');
    expect(engine.isASBR()).toBe(false);
  });

  it('2.05 – originateASBRSummaryLSA() creates a Type 4 LSA in target area', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    const lsa = abr.originateASBRSummaryLSA('0.0.0.1', '5.5.5.5', 15);
    expect(lsa.lsType).toBe(4);
    // For Type 4, linkStateId = ASBR Router ID
    expect(lsa.linkStateId).toBe('5.5.5.5');
    expect(lsa.advertisingRouter).toBe('1.1.1.1');
    expect(lsa.networkMask).toBe('0.0.0.0');
    expect(lsa.metric).toBe(15);

    const areaDB = abr.getAreaLSDB('0.0.0.1');
    expect(areaDB).toBeDefined();
    const key = makeLSDBKey(4, '5.5.5.5', '1.1.1.1');
    expect(areaDB!.has(key)).toBe(true);

    abr.shutdown();
  });

  it('2.06 – Type 4 LSA has correct length (28 bytes)', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    const lsa = abr.originateASBRSummaryLSA('0.0.0.1', '5.5.5.5', 15);
    expect(lsa.length).toBe(28);

    abr.shutdown();
  });

  it('2.07 – runSPF() on ABR auto-originates Type 4 LSA when ASBR is present in connected area', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });

    // Install ABR's own Router-LSA in area 1 (B-bit) and ASBR Router-LSA (E-bit set)
    abr.installLSA('0.0.0.1', makeRouterLSA('1.1.1.1', 0x01, [ // B-bit
      { linkId: '5.5.5.5', linkData: '10.1.0.1', type: 1, numTOS: 0, metric: 1 },
    ]));
    abr.installLSA('0.0.0.1', makeRouterLSA('5.5.5.5', 0x02)); // E-bit = ASBR

    // ABR's Router-LSA in backbone
    abr.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1', 0x01));

    abr.runSPF();

    // ABR should have originated Type 4 LSA for ASBR 5.5.5.5 into backbone
    const backboneDB = abr.getAreaLSDB(OSPF_BACKBONE_AREA);
    expect(backboneDB).toBeDefined();
    const type4key = makeLSDBKey(4, '5.5.5.5', '1.1.1.1');
    expect(backboneDB!.has(type4key)).toBe(true);

    abr.shutdown();
  });

});

// ════════════════════════════════════════════════════════════════════════════
// GROUP 3 – Type 7 NSSA External LSA + ABR translation
// ════════════════════════════════════════════════════════════════════════════

describe('OSPF Type 7 NSSA External LSA', () => {

  it('3.01 – originateNSSAExternalLSA() creates a Type 7 LSA in the NSSA area', () => {
    const asbr = makeEngine('2.2.2.2');
    asbr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    asbr.activateInterface('eth0', '10.1.0.2', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    asbr.setAreaType('0.0.0.1', 'nssa');

    const lsa = asbr.originateNSSAExternalLSA('0.0.0.1', '172.16.0.0', '255.255.0.0', 20);
    expect(lsa.lsType).toBe(7);
    expect(lsa.linkStateId).toBe('172.16.0.0');
    expect(lsa.advertisingRouter).toBe('2.2.2.2');
    expect(lsa.networkMask).toBe('255.255.0.0');
    expect(lsa.metric).toBe(20);

    asbr.shutdown();
  });

  it('3.02 – Type 7 LSA is stored in area LSDB (not external LSDB)', () => {
    const asbr = makeEngine('2.2.2.2');
    asbr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    asbr.activateInterface('eth0', '10.1.0.2', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    asbr.setAreaType('0.0.0.1', 'nssa');

    asbr.originateNSSAExternalLSA('0.0.0.1', '172.16.0.0', '255.255.0.0', 20);

    // Should be in area LSDB
    const areaDB = asbr.getAreaLSDB('0.0.0.1');
    expect(areaDB).toBeDefined();
    const key = makeLSDBKey(7, '172.16.0.0', '2.2.2.2');
    expect(areaDB!.has(key)).toBe(true);

    // Should NOT be in external LSDB (which is for Type 5 only)
    const lsdb = asbr.getLSDB();
    const extKey = makeLSDBKey(7, '172.16.0.0', '2.2.2.2');
    expect(lsdb.external.has(extKey)).toBe(false);

    asbr.shutdown();
  });

  it('3.03 – Type 7 LSA structure has N-bit set in options and correct metric type', () => {
    const asbr = makeEngine('2.2.2.2');
    asbr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    asbr.activateInterface('eth0', '10.1.0.2', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    asbr.setAreaType('0.0.0.1', 'nssa');

    const lsa = asbr.originateNSSAExternalLSA('0.0.0.1', '172.16.0.0', '255.255.0.0', 20, 2);
    // N-bit (0x08) should be set in options for NSSA LSAs
    expect(lsa.options & 0x08).toBeTruthy();
    expect(lsa.metricType).toBe(2);
    expect(lsa.forwardingAddress).toBe('0.0.0.0');

    asbr.shutdown();
  });

  it('3.04 – translateNSSAtoExternal() produces a Type 5 LSA from a Type 7', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    abr.setAreaType('0.0.0.1', 'nssa');

    const nssaLsa: NSSAExternalLSA = {
      lsAge: 0,
      options: 0x08,
      lsType: 7,
      linkStateId: '172.16.0.0',
      advertisingRouter: '2.2.2.2',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0,
      length: 36,
      networkMask: '255.255.0.0',
      metricType: 2,
      metric: 20,
      forwardingAddress: '0.0.0.0',
      externalRouteTag: 0,
    };

    const externalLsa = abr.translateNSSAtoExternal(nssaLsa);
    expect(externalLsa.lsType).toBe(5);
    expect(externalLsa.linkStateId).toBe('172.16.0.0');
    expect(externalLsa.networkMask).toBe('255.255.0.0');
    expect(externalLsa.metricType).toBe(2);
    expect(externalLsa.metric).toBe(20);
    // ABR becomes the advertising router
    expect(externalLsa.advertisingRouter).toBe('1.1.1.1');

    abr.shutdown();
  });

  it('3.05 – translateNSSAtoExternal() stores the Type 5 LSA in external LSDB', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    abr.setAreaType('0.0.0.1', 'nssa');

    const nssaLsa: NSSAExternalLSA = {
      lsAge: 0,
      options: 0x08,
      lsType: 7,
      linkStateId: '172.16.0.0',
      advertisingRouter: '2.2.2.2',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0,
      length: 36,
      networkMask: '255.255.0.0',
      metricType: 2,
      metric: 20,
      forwardingAddress: '0.0.0.0',
      externalRouteTag: 0,
    };

    abr.translateNSSAtoExternal(nssaLsa);

    // Type 5 should be in external LSDB
    const lsdb = abr.getLSDB();
    const extKey = makeLSDBKey(5, '172.16.0.0', '1.1.1.1');
    expect(lsdb.external.has(extKey)).toBe(true);

    const stored = lsdb.external.get(extKey)!;
    expect(stored.lsType).toBe(5);
    expect(stored.metric).toBe(20);

    abr.shutdown();
  });

  it('3.06 – ABR auto-translates received Type 7 to Type 5 via installLSA', () => {
    const abr = makeEngine('1.1.1.1');
    abr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    abr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    abr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    abr.activateInterface('eth1', '10.1.0.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    abr.setAreaType('0.0.0.1', 'nssa');

    // Install a Type 7 LSA in the NSSA area
    const nssaLsa: NSSAExternalLSA = {
      lsAge: 0,
      options: 0x08,
      lsType: 7,
      linkStateId: '10.99.0.0',
      advertisingRouter: '3.3.3.3',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0,
      length: 36,
      networkMask: '255.255.0.0',
      metricType: 1,
      metric: 10,
      forwardingAddress: '0.0.0.0',
      externalRouteTag: 0,
    };

    // When ABR installs a Type 7 in an NSSA area, it should auto-translate to Type 5
    abr.installLSA('0.0.0.1', nssaLsa);

    const lsdb = abr.getLSDB();
    const extKey = makeLSDBKey(5, '10.99.0.0', '1.1.1.1');
    expect(lsdb.external.has(extKey)).toBe(true);

    abr.shutdown();
  });

});

// ════════════════════════════════════════════════════════════════════════════
// GROUP 4 – OSPFv3 Link-LSA (0x0008) and Intra-Area-Prefix-LSA (0x2009)
// ════════════════════════════════════════════════════════════════════════════

describe('OSPFv3 Link-LSA (0x0008)', () => {

  it('4.01 – OSPFV3_LSA_LINK constant is 0x0008', () => {
    expect(OSPFV3_LSA_LINK).toBe(0x0008);
  });

  it('4.02 – activateInterface() auto-originates a Link-LSA for the interface', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.activateInterface('eth0', '0.0.0.0', {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    const linkLsa = engine.getLinkLSA('eth0');
    expect(linkLsa).toBeDefined();
    expect(linkLsa!.lsType).toBe(OSPFV3_LSA_LINK);

    engine.shutdown();
  });

  it('4.03 – Link-LSA linkStateId is the interface ID', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    const iface = engine.activateInterface('eth0', '0.0.0.0', {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    const linkLsa = engine.getLinkLSA('eth0');
    expect(linkLsa).toBeDefined();
    // linkStateId should equal the interface's interfaceId (as a string or number)
    expect(linkLsa!.linkStateId).toBe(String(iface.interfaceId));
    expect(linkLsa!.advertisingRouter).toBe('1.1.1.1');

    engine.shutdown();
  });

  it('4.04 – Link-LSA contains router priority and link-local address', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.activateInterface('eth0', '0.0.0.0', {
      networkType: 'point-to-point',
      priority: 5,
      ipAddress: 'fe80::cafe:1',
    });

    const linkLsa = engine.getLinkLSA('eth0');
    expect(linkLsa).toBeDefined();
    expect(linkLsa!.priority).toBe(5);
    expect(linkLsa!.linkLocalAddress).toBe('fe80::cafe:1');

    engine.shutdown();
  });

  it('4.05 – originateLinkLSA() can be called explicitly with prefixes', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('2.2.2.2');
    engine.activateInterface('eth0', '0.0.0.0', {
      networkType: 'point-to-point',
      ipAddress: 'fe80::2',
    });

    const lsa = engine.originateLinkLSA('eth0', 'fe80::2:1', [
      { prefix: '2001:db8:1::', prefixLen: 48, metric: 1, prefixOptions: 0 },
    ]);

    expect(lsa.lsType).toBe(OSPFV3_LSA_LINK);
    expect(lsa.linkLocalAddress).toBe('fe80::2:1');
    expect(lsa.prefixes).toHaveLength(1);
    expect(lsa.prefixes[0].prefix).toBe('2001:db8:1::');

    engine.shutdown();
  });

});

describe('OSPFv3 Intra-Area-Prefix-LSA (0x2009)', () => {

  it('4.06 – OSPFV3_LSA_INTRA_AREA_PREFIX constant is 0x2009', () => {
    expect(OSPFV3_LSA_INTRA_AREA_PREFIX).toBe(0x2009);
  });

  it('4.07 – originateIntraAreaPrefixLSA() creates a Type 0x2009 LSA', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.addArea('0.0.0.0');
    engine.activateInterface('eth0', '0.0.0.0', {
      networkType: 'point-to-point',
      ipAddress: 'fe80::1',
    });

    const lsa = engine.originateIntraAreaPrefixLSA('0.0.0.0', [
      { prefix: '2001:db8::', prefixLen: 32, metric: 1, prefixOptions: 0 },
    ]);

    expect(lsa.lsType).toBe(OSPFV3_LSA_INTRA_AREA_PREFIX);
    expect(lsa.advertisingRouter).toBe('1.1.1.1');
    expect(lsa.numPrefixes).toBe(1);
    expect(lsa.prefixes[0].prefix).toBe('2001:db8::');

    engine.shutdown();
  });

  it('4.08 – Intra-Area-Prefix-LSA references the Router-LSA (referencedLSType = 0x2001)', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.addArea('0.0.0.0');
    engine.activateInterface('eth0', '0.0.0.0', { networkType: 'point-to-point' });

    const lsa = engine.originateIntraAreaPrefixLSA('0.0.0.0', [
      { prefix: '2001:db8:1::', prefixLen: 48, metric: 5, prefixOptions: 0 },
    ]);

    expect(lsa.referencedLSType).toBe(0x2001); // References Router-LSA
    expect(lsa.referencedLSId).toBe('0'); // Router-LSA link state ID = 0 for router
    expect(lsa.referencedAdvRouter).toBe('1.1.1.1');

    engine.shutdown();
  });

  it('4.09 – getIntraAreaPrefixLSA() retrieves the stored LSA for an area', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.addArea('0.0.0.0');
    engine.activateInterface('eth0', '0.0.0.0', { networkType: 'point-to-point' });

    engine.originateIntraAreaPrefixLSA('0.0.0.0', [
      { prefix: '2001:db8::', prefixLen: 32, metric: 1, prefixOptions: 0 },
    ]);

    const stored = engine.getIntraAreaPrefixLSA('0.0.0.0');
    expect(stored).toBeDefined();
    expect(stored!.lsType).toBe(OSPFV3_LSA_INTRA_AREA_PREFIX);
    expect(stored!.prefixes).toHaveLength(1);

    engine.shutdown();
  });

  it('4.10 – Multiple prefixes are correctly stored in Intra-Area-Prefix-LSA', () => {
    const engine = new OSPFv3Engine(1);
    engine.setRouterId('1.1.1.1');
    engine.addArea('0.0.0.0');
    engine.activateInterface('eth0', '0.0.0.0', { networkType: 'point-to-point' });

    const prefixes = [
      { prefix: '2001:db8:1::', prefixLen: 48, metric: 1, prefixOptions: 0 },
      { prefix: '2001:db8:2::', prefixLen: 48, metric: 2, prefixOptions: 0 },
      { prefix: 'fd00::', prefixLen: 8, metric: 1, prefixOptions: 0 },
    ];

    const lsa = engine.originateIntraAreaPrefixLSA('0.0.0.0', prefixes);
    expect(lsa.numPrefixes).toBe(3);
    expect(lsa.prefixes).toHaveLength(3);
    expect(lsa.prefixes[1].prefix).toBe('2001:db8:2::');
    expect(lsa.prefixes[2].prefixLen).toBe(8);

    engine.shutdown();
  });

});
