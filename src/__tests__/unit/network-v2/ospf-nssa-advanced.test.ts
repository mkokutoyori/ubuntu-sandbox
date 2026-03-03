/**
 * OSPF NSSA Advanced TDD Test Suite — Step 7
 *
 * Tests for five previously missing / incomplete NSSA features:
 *   1. Type 7 auto-generation  — redistributeExternalRoute() uses Type 7 in NSSA,
 *                                Type 5 in normal areas
 *   2. Type 7 → Type 5 at ABR — auto-translation edge-cases not covered by step-3 tests
 *   3. Conditional default     — ABR originates Type 7 default into NSSA when
 *                                nssaDefaultInfoOriginate = true
 *   4. Totally NSSA            — nssaNoSummary blocks Type 3 and injects Type 3 default
 *   5. Area Range              — addAreaRange() aggregates routes, suppresses individual
 *                                routes that fall inside the range
 *
 * Groups 3-5 test the ABR summarisation logic directly via
 * originateSummariesAsABR() (exposed as public) with hand-crafted route maps,
 * so that full SPF setup is not required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  makeLSDBKey,
  type OSPFRouteEntry,
  type NSSAExternalLSA,
  type SummaryLSA,
  type ExternalLSA,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEngine(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  return e;
}

/** Build a fake intra-area OSPFRouteEntry for ABR summarisation tests. */
function fakeRoute(network: string, mask: string, cost: number, areaId: string): OSPFRouteEntry {
  return {
    network,
    mask,
    routeType: 'intra-area',
    areaId,
    nextHop: '192.168.0.1',
    iface: 'eth0',
    cost,
    advertisingRouter: '2.2.2.2',
  };
}

/**
 * Create a minimal ABR engine:
 *   - interface eth0 in backbone (area 0)
 *   - interface eth1 in area 1 (type controlled by caller)
 */
function makeABR(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  e.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  e.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
  e.addNetwork('192.168.1.0', '0.0.0.255', '0.0.0.1');
  e.activateInterface('eth1', '192.168.1.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — Type 7 auto-generation via redistributeExternalRoute()
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — redistributeExternalRoute(): Type 7 in NSSA, Type 5 elsewhere', () => {

  it('1.1 — NSSA ASBR: redistributeExternalRoute() generates a Type 7 in area LSDB', () => {
    const asbr = makeEngine('2.2.2.2');
    asbr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    asbr.activateInterface('eth0', '10.1.0.2', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    asbr.setAreaType('0.0.0.1', 'nssa');

    asbr.redistributeExternalRoute('172.16.0.0', '255.255.0.0', 20);

    const areaDB = asbr.getAreaLSDB('0.0.0.1')!;
    const key = makeLSDBKey(7, '172.16.0.0', '2.2.2.2');
    expect(areaDB.has(key)).toBe(true);
    const lsa = areaDB.get(key) as NSSAExternalLSA;
    expect(lsa.lsType).toBe(7);
    expect(lsa.metric).toBe(20);
  });

  it('1.2 — Normal ASBR: redistributeExternalRoute() generates a Type 5 in external LSDB', () => {
    const asbr = makeEngine('1.1.1.1');
    asbr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    asbr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

    asbr.redistributeExternalRoute('172.16.0.0', '255.255.0.0', 20);

    const lsdb = asbr.getLSDB();
    const key = makeLSDBKey(5, '172.16.0.0', '1.1.1.1');
    expect(lsdb.external.has(key)).toBe(true);
    const lsa = lsdb.external.get(key) as ExternalLSA;
    expect(lsa.lsType).toBe(5);
    expect(lsa.metric).toBe(20);
  });

  it('1.3 — NSSA ASBR: no Type 5 generated in external LSDB for NSSA area', () => {
    const asbr = makeEngine('2.2.2.2');
    asbr.addNetwork('10.1.0.0', '0.0.0.255', '0.0.0.1');
    asbr.activateInterface('eth0', '10.1.0.2', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    asbr.setAreaType('0.0.0.1', 'nssa');

    asbr.redistributeExternalRoute('172.16.0.0', '255.255.0.0', 20);

    const lsdb = asbr.getLSDB();
    const key = makeLSDBKey(5, '172.16.0.0', '2.2.2.2');
    expect(lsdb.external.has(key)).toBe(false);
  });

  it('1.4 — ABR+ASBR: generates Type 7 in NSSA and Type 5 in backbone', () => {
    // Router with both backbone and NSSA interface (ABR + ASBR)
    const router = makeEngine('1.1.1.1');
    router.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    router.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });
    router.addNetwork('192.168.1.0', '0.0.0.255', '0.0.0.1');
    router.activateInterface('eth1', '192.168.1.1', '255.255.255.0', '0.0.0.1', { networkType: 'point-to-point' });
    router.setAreaType('0.0.0.1', 'nssa');

    router.redistributeExternalRoute('172.16.0.0', '255.255.0.0', 20);

    // Type 7 in NSSA area LSDB
    const areaDB = router.getAreaLSDB('0.0.0.1')!;
    expect(areaDB.has(makeLSDBKey(7, '172.16.0.0', '1.1.1.1'))).toBe(true);

    // Type 5 in external LSDB
    const lsdb = router.getLSDB();
    expect(lsdb.external.has(makeLSDBKey(5, '172.16.0.0', '1.1.1.1'))).toBe(true);
  });

  it('1.5 — originateExternalLSA() directly creates a Type 5 LSA', () => {
    const asbr = makeEngine('1.1.1.1');
    asbr.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
    asbr.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, { networkType: 'point-to-point' });

    const lsa = asbr.originateExternalLSA('10.100.0.0', '255.255.0.0', 15);

    expect(lsa.lsType).toBe(5);
    expect(lsa.metric).toBe(15);
    expect(lsa.networkMask).toBe('255.255.0.0');

    const lsdb = asbr.getLSDB();
    expect(lsdb.external.has(makeLSDBKey(5, '10.100.0.0', '1.1.1.1'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — configureNSSA() API
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — configureNSSA(): area option setters', () => {

  it('2.1 — configureNSSA() sets area type to nssa', () => {
    const e = makeEngine('1.1.1.1');
    e.addNetwork('10.0.0.0', '0.0.0.255', '0.0.0.1');
    e.configureNSSA('0.0.0.1', {});
    const area = e.getLSDB().areas.get('0.0.0.1');
    // Area LSDB is created
    expect(area).toBeDefined();
    // getAreaType convenience: area type is 'nssa'
    const areaConf = (e as any).config.areas.get('0.0.0.1');
    expect(areaConf?.type).toBe('nssa');
  });

  it('2.2 — configureNSSA({noSummary: true}) sets nssaNoSummary', () => {
    const e = makeEngine('1.1.1.1');
    e.configureNSSA('0.0.0.1', { noSummary: true });
    const area = (e as any).config.areas.get('0.0.0.1');
    expect(area?.nssaNoSummary).toBe(true);
    expect(area?.type).toBe('nssa');
  });

  it('2.3 — configureNSSA({defaultInfoOriginate: true}) sets nssaDefaultInfoOriginate', () => {
    const e = makeEngine('1.1.1.1');
    e.configureNSSA('0.0.0.1', { defaultInfoOriginate: true });
    const area = (e as any).config.areas.get('0.0.0.1');
    expect(area?.nssaDefaultInfoOriginate).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — Conditional default route (nssaDefaultInfoOriginate)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — Conditional default route (nssaDefaultInfoOriginate)', () => {

  it('3.1 — ABR with defaultInfoOriginate=true: Type 7 default appears in NSSA after summarisation', () => {
    const abr = makeABR('1.1.1.1');
    abr.configureNSSA('0.0.0.1', { defaultInfoOriginate: true });

    // Trigger ABR summarisation with empty route maps
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, []],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    // Type 7 default must be in NSSA area LSDB
    const areaDB = abr.getAreaLSDB('0.0.0.1')!;
    const key = makeLSDBKey(7, '0.0.0.0', '1.1.1.1');
    expect(areaDB.has(key)).toBe(true);
    const lsa = areaDB.get(key) as NSSAExternalLSA;
    expect(lsa.lsType).toBe(7);
    expect(lsa.linkStateId).toBe('0.0.0.0');
    expect(lsa.networkMask).toBe('0.0.0.0');
  });

  it('3.2 — ABR without defaultInfoOriginate: no Type 7 default in NSSA', () => {
    const abr = makeABR('1.1.1.1');
    abr.setAreaType('0.0.0.1', 'nssa'); // just nssa, no defaultInfoOriginate

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, []],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    const key = makeLSDBKey(7, '0.0.0.0', '1.1.1.1');
    expect(areaDB.has(key)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — Totally NSSA (nssaNoSummary)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4 — Totally NSSA (nssaNoSummary)', () => {

  it('4.1 — Totally NSSA: Type 3 Summary LSAs are NOT flooded into the area', () => {
    const abr = makeABR('1.1.1.1');
    abr.configureNSSA('0.0.0.1', { noSummary: true });

    // Area 0 has an intra-area route 172.16.0.0/16
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [fakeRoute('172.16.0.0', '255.255.0.0', 10, OSPF_BACKBONE_AREA)]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    // No Type 3 for 172.16.0.0 should appear in the Totally NSSA area
    const areaDB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    const key = makeLSDBKey(3, '172.16.0.0', '1.1.1.1');
    expect(areaDB.has(key)).toBe(false);
  });

  it('4.2 — Totally NSSA: a Type 3 default (0.0.0.0/0) IS generated for the area', () => {
    const abr = makeABR('1.1.1.1');
    abr.configureNSSA('0.0.0.1', { noSummary: true });

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [fakeRoute('172.16.0.0', '255.255.0.0', 10, OSPF_BACKBONE_AREA)]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    // Type 3 default must exist
    const areaDB = abr.getAreaLSDB('0.0.0.1')!;
    const defaultKey = makeLSDBKey(3, '0.0.0.0', '1.1.1.1');
    expect(areaDB.has(defaultKey)).toBe(true);
    const lsa = areaDB.get(defaultKey) as SummaryLSA;
    expect(lsa.lsType).toBe(3);
    expect(lsa.networkMask).toBe('0.0.0.0');
  });

  it('4.3 — Totally NSSA: Type 3 routes still flow from NSSA into backbone', () => {
    const abr = makeABR('1.1.1.1');
    abr.configureNSSA('0.0.0.1', { noSummary: true });

    // Area 1 has an intra-area route 10.1.0.0/24
    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, []],
      ['0.0.0.1', [fakeRoute('10.1.0.0', '255.255.255.0', 5, '0.0.0.1')]],
    ]);
    abr.originateSummariesAsABR(routes);

    // Type 3 for 10.1.0.0 should appear in backbone
    const bbDB = abr.getAreaLSDB(OSPF_BACKBONE_AREA)!;
    const key = makeLSDBKey(3, '10.1.0.0', '1.1.1.1');
    expect(bbDB.has(key)).toBe(true);
  });

  it('4.4 — Totally NSSA with defaultInfoOriginate also gets Type 7 default', () => {
    const abr = makeABR('1.1.1.1');
    abr.configureNSSA('0.0.0.1', { noSummary: true, defaultInfoOriginate: true });

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, []],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1')!;
    // Both Type 3 default and Type 7 default
    expect(areaDB.has(makeLSDBKey(3, '0.0.0.0', '1.1.1.1'))).toBe(true);
    expect(areaDB.has(makeLSDBKey(7, '0.0.0.0', '1.1.1.1'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5 — Area Range (route aggregation + suppression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5 — Area Range (addAreaRange)', () => {

  it('5.1 — routes within range produce an aggregate Type 3 (not individual ones)', () => {
    const abr = makeABR('1.1.1.1');
    // Range: 192.168.0.0/16 covers both 192.168.1.0/24 and 192.168.2.0/24
    abr.addAreaRange(OSPF_BACKBONE_AREA, '192.168.0.0', '255.255.0.0');

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        fakeRoute('192.168.1.0', '255.255.255.0', 10, OSPF_BACKBONE_AREA),
        fakeRoute('192.168.2.0', '255.255.255.0', 15, OSPF_BACKBONE_AREA),
      ]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1') ?? new Map();

    // Aggregate must be present
    expect(areaDB.has(makeLSDBKey(3, '192.168.0.0', '1.1.1.1'))).toBe(true);
    // Individual routes must NOT be present
    expect(areaDB.has(makeLSDBKey(3, '192.168.1.0', '1.1.1.1'))).toBe(false);
    expect(areaDB.has(makeLSDBKey(3, '192.168.2.0', '1.1.1.1'))).toBe(false);
  });

  it('5.2 — aggregate metric equals the maximum cost among covered routes', () => {
    const abr = makeABR('1.1.1.1');
    abr.addAreaRange(OSPF_BACKBONE_AREA, '192.168.0.0', '255.255.0.0');

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        fakeRoute('192.168.1.0', '255.255.255.0', 10, OSPF_BACKBONE_AREA),
        fakeRoute('192.168.2.0', '255.255.255.0', 25, OSPF_BACKBONE_AREA), // higher cost
      ]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1')!;
    const agg = areaDB.get(makeLSDBKey(3, '192.168.0.0', '1.1.1.1')) as SummaryLSA;
    expect(agg.metric).toBe(25); // max of 10 and 25
  });

  it('5.3 — routes outside the range are still advertised individually', () => {
    const abr = makeABR('1.1.1.1');
    abr.addAreaRange(OSPF_BACKBONE_AREA, '192.168.0.0', '255.255.0.0');

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        fakeRoute('192.168.1.0', '255.255.255.0', 10, OSPF_BACKBONE_AREA), // inside range
        fakeRoute('10.0.1.0', '255.255.255.0', 5, OSPF_BACKBONE_AREA),     // outside range
      ]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1')!;

    // Aggregate for 192.168.0.0/16
    expect(areaDB.has(makeLSDBKey(3, '192.168.0.0', '1.1.1.1'))).toBe(true);
    // Individual for 10.0.1.0
    expect(areaDB.has(makeLSDBKey(3, '10.0.1.0', '1.1.1.1'))).toBe(true);
    // No individual 192.168.1.0
    expect(areaDB.has(makeLSDBKey(3, '192.168.1.0', '1.1.1.1'))).toBe(false);
  });

  it('5.4 — no aggregate Type 3 if no routes fall within the range', () => {
    const abr = makeABR('1.1.1.1');
    abr.addAreaRange(OSPF_BACKBONE_AREA, '172.16.0.0', '255.255.0.0'); // different prefix

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        fakeRoute('10.0.1.0', '255.255.255.0', 5, OSPF_BACKBONE_AREA), // does NOT match range
      ]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    // Aggregate for 172.16.0.0 must NOT be present (no routes match)
    expect(areaDB.has(makeLSDBKey(3, '172.16.0.0', '1.1.1.1'))).toBe(false);
    // Individual 10.0.1.0 IS present (not covered)
    expect(areaDB.has(makeLSDBKey(3, '10.0.1.0', '1.1.1.1'))).toBe(true);
  });

  it('5.5 — range with advertise=false suppresses routes without generating aggregate', () => {
    const abr = makeABR('1.1.1.1');
    abr.addAreaRange(OSPF_BACKBONE_AREA, '192.168.0.0', '255.255.0.0', false); // not-advertise

    const routes = new Map<string, OSPFRouteEntry[]>([
      [OSPF_BACKBONE_AREA, [
        fakeRoute('192.168.1.0', '255.255.255.0', 10, OSPF_BACKBONE_AREA),
      ]],
      ['0.0.0.1', []],
    ]);
    abr.originateSummariesAsABR(routes);

    const areaDB = abr.getAreaLSDB('0.0.0.1') ?? new Map();
    // Neither aggregate nor individual should appear
    expect(areaDB.has(makeLSDBKey(3, '192.168.0.0', '1.1.1.1'))).toBe(false);
    expect(areaDB.has(makeLSDBKey(3, '192.168.1.0', '1.1.1.1'))).toBe(false);
  });
});
