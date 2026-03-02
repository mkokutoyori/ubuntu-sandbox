/**
 * OSPF Timers & LSA Aging TDD Test Suite — Step 5
 *
 * Tests for six previously missing features:
 *   1. LSA Aging       — lsAge incremented each second; LSAs purged at MaxAge (3600s)
 *   2. LSA Refresh     — own LSAs re-originated every 1800s (seq bumped, age reset)
 *   3. MinLSInterval   — 5s rate-limit on self-originated LSA flooding
 *   4. MinLSArrival    — 1s protection against receiving the same LSA twice too fast
 *   5. SPF Throttle    — exponential back-off: initial / hold / max
 *   6. timers throttle spf — configurable throttle stored and used by scheduleSPF()
 *
 * All tests use vi.useFakeTimers() to drive time deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_MAX_AGE,
  OSPF_LS_REFRESH_TIME,
  OSPF_MIN_LS_INTERVAL,
  OSPF_MIN_LS_ARRIVAL,
  OSPF_VERSION_2,
  makeLSDBKey,
  type RouterLSA,
  type SummaryLSA,
  type ExternalLSA,
  type OSPFNeighbor,
  type OSPFLSUpdatePacket,
} from '@/network/ospf/types';
import { OSPFEngine, computeOSPFLSAChecksum } from '@/network/ospf/OSPFEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEngine(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  e.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  return e;
}

/** Create a Router-LSA with a valid Fletcher-16 checksum (required by processLSUpdate). */
function makeRouterLSA(routerId: string, seq = OSPF_INITIAL_SEQUENCE_NUMBER, age = 0): RouterLSA {
  const lsa: RouterLSA = {
    lsAge: age,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter: routerId,
    lsSequenceNumber: seq,
    checksum: 0,
    length: 24,
    flags: 0,
    numLinks: 0,
    links: [],
  };
  lsa.checksum = computeOSPFLSAChecksum(lsa);
  return lsa;
}

/** Create a fake LSU packet containing one LSA (simulates reception from a neighbor). */
function makeLSU(lsa: RouterLSA, senderRouterId: string): OSPFLSUpdatePacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_2,
    packetType: 4,
    routerId: senderRouterId,
    areaId: OSPF_BACKBONE_AREA,
    numLSAs: 1,
    lsas: [lsa],
  };
}

/** Create a fake Full neighbor (no real Hello exchange needed). */
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

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: LSA Aging (lsAge increment + MaxAge purge)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — LSA Aging (lsAge increment + MaxAge purge)', () => {
  let engine: OSPFEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine('1.1.1.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('1.01 — tickLSAge increments lsAge of every area LSA by 1 per tick', () => {
    // Install a foreign LSA (age starts at 0)
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', OSPF_INITIAL_SEQUENCE_NUMBER, 0));
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2')!;
    expect(lsa.lsAge).toBe(0);

    engine.tickLSAge();
    expect(lsa.lsAge).toBe(1);

    engine.tickLSAge();
    engine.tickLSAge();
    expect(lsa.lsAge).toBe(3);
  });

  it('1.02 — startLSAgeTimer drives tickLSAge via setInterval(1000ms)', () => {
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER, 0));
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3')!;

    engine.startLSAgeTimer();
    expect(lsa.lsAge).toBe(0);

    vi.advanceTimersByTime(3_000); // 3 seconds
    expect(lsa.lsAge).toBe(3);
  });

  it('1.03 — LSA reaching MaxAge (3600) is removed from the area LSDB', () => {
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('4.4.4.4', OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_AGE - 1));
    expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '4.4.4.4', '4.4.4.4')).toBeDefined();

    engine.tickLSAge(); // lsAge 3599 → 3600 → purge
    expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '4.4.4.4', '4.4.4.4')).toBeUndefined();
  });

  it('1.04 — MaxAge purge of external LSA (Type 5) cleans external LSDB', () => {
    const extLSA: ExternalLSA = {
      lsAge: OSPF_MAX_AGE - 1,
      options: 0x02,
      lsType: 5,
      linkStateId: '192.168.1.0',
      advertisingRouter: '5.5.5.5',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0x1234,
      length: 36,
      networkMask: '255.255.255.0',
      metricType: 2,
      metric: 20,
      forwardingAddress: '0.0.0.0',
      externalRouteTag: 0,
    };
    engine.installLSA(OSPF_BACKBONE_AREA, extLSA);
    expect(engine.getLSDB().external.size).toBeGreaterThan(0);

    engine.tickLSAge();
    expect(engine.getLSDB().external.size).toBe(0);
  });

  it('1.05 — MaxAge purge triggers scheduleSPF (a SPF timer is set)', () => {
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('6.6.6.6', OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_AGE - 1));
    const spySPF = vi.spyOn(engine, 'runSPF');

    engine.tickLSAge(); // purge triggers scheduleSPF → setTimeout(runSPF, 200ms)
    expect(spySPF).not.toHaveBeenCalled(); // not yet — still in delay

    vi.advanceTimersByTime(200);
    expect(spySPF).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: LSA Refresh Timer (30-min re-origination)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — LSA Refresh Timer (1800s re-origination)', () => {
  let engine: OSPFEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine('1.1.1.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('2.01 — own LSA reaching LS_REFRESH_TIME (1800) is refreshed: age reset to 0, seq bumped', () => {
    // Get our own Router-LSA (installed by activateInterface)
    const myRid = '1.1.1.1';
    const lsaBefore = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, myRid, myRid) as RouterLSA;
    expect(lsaBefore).toBeDefined();
    const seqBefore = lsaBefore.lsSequenceNumber;

    // Manually age it to exactly LS_REFRESH_TIME - 1
    lsaBefore.lsAge = OSPF_LS_REFRESH_TIME - 1;

    // One more tick brings it to exactly OSPF_LS_REFRESH_TIME → refresh
    engine.tickLSAge();

    const lsaAfter = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, myRid, myRid) as RouterLSA;
    expect(lsaAfter.lsAge).toBe(0);
    expect(lsaAfter.lsSequenceNumber).toBeGreaterThan(seqBefore);
  });

  it('2.02 — foreign LSA (advertisingRouter != self) is NOT refreshed at LS_REFRESH_TIME', () => {
    // Install a foreign LSA at age OSPF_LS_REFRESH_TIME - 1
    engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2', OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_LS_REFRESH_TIME - 1));
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2')!;
    const seqBefore = lsa.lsSequenceNumber;

    engine.tickLSAge();

    // Age should have incremented (to OSPF_LS_REFRESH_TIME), NOT been reset to 0
    expect(lsa.lsAge).toBe(OSPF_LS_REFRESH_TIME);
    // Seq should NOT be bumped (we don't own this LSA)
    expect(lsa.lsSequenceNumber).toBe(seqBefore);
  });

  it('2.03 — refreshed own LSA is flooded to Full neighbors', () => {
    const myRid = '1.1.1.1';
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, myRid, myRid) as RouterLSA;
    expect(lsa).toBeDefined();

    // Wire engine so we can observe floods
    const sentPackets: OSPFLSUpdatePacket[] = [];
    engine.setSendCallback((_iface, pkt) => {
      if (pkt.packetType === 4) sentPackets.push(pkt as OSPFLSUpdatePacket);
    });

    // Add a fake Full neighbor so flooding has somewhere to go
    const iface = engine.getInterface('eth0')!;
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));

    // Age our LSA to OSPF_LS_REFRESH_TIME - 1 and then tick
    lsa.lsAge = OSPF_LS_REFRESH_TIME - 1;
    // Also reset lastFloodTime so the refresh flood is not suppressed
    vi.advanceTimersByTime(OSPF_MIN_LS_INTERVAL * 1000 + 100); // advance past MinLSInterval

    const sentBefore = sentPackets.length;
    engine.tickLSAge();

    // The refresh should have generated a flood (LSU)
    expect(sentPackets.length).toBeGreaterThan(sentBefore);
    const lsu = sentPackets[sentPackets.length - 1];
    expect(lsu.lsas[0].advertisingRouter).toBe(myRid);
    expect(lsu.lsas[0].lsAge).toBe(0);
  });

  it('2.04 — startLSAgeTimer drives refresh after 1800 seconds via setInterval', () => {
    const myRid = '1.1.1.1';
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, myRid, myRid) as RouterLSA;
    const seqBefore = lsa.lsSequenceNumber;

    engine.startLSAgeTimer();
    vi.advanceTimersByTime(OSPF_LS_REFRESH_TIME * 1000); // 1800 seconds

    const lsaAfter = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, myRid, myRid) as RouterLSA;
    expect(lsaAfter).toBeDefined();
    expect(lsaAfter.lsAge).toBe(0);
    expect(lsaAfter.lsSequenceNumber).toBeGreaterThan(seqBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: MinLSInterval (5s rate-limiting on self-originated LSA flooding)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — MinLSInterval (5s rate-limit on self-originated flooding)', () => {
  let engine: OSPFEngine;
  let sentLSUs: OSPFLSUpdatePacket[];

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine('1.1.1.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
    sentLSUs = [];
    engine.setSendCallback((_iface, pkt) => {
      if (pkt.packetType === 4) sentLSUs.push(pkt as OSPFLSUpdatePacket);
    });

    // Add a fake Full neighbor so flooding has a destination
    const iface = engine.getInterface('eth0')!;
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('3.01 — first origination is always sent (no prior flood)', () => {
    sentLSUs = [];
    engine.originateRouterLSA(OSPF_BACKBONE_AREA);
    // The flood should be sent to the Full neighbor
    expect(sentLSUs.some(lsu => lsu.lsas.some(lsa => lsa.advertisingRouter === '1.1.1.1'))).toBe(true);
  });

  it('3.02 — second origination within MinLSInterval (5s) is rate-limited (flood suppressed)', () => {
    // First origination
    engine.originateRouterLSA(OSPF_BACKBONE_AREA);
    const countAfterFirst = sentLSUs.filter(lsu => lsu.lsas.some(l => l.advertisingRouter === '1.1.1.1')).length;

    // Second origination immediately (< 5s)
    engine.originateRouterLSA(OSPF_BACKBONE_AREA);
    const countAfterSecond = sentLSUs.filter(lsu => lsu.lsas.some(l => l.advertisingRouter === '1.1.1.1')).length;

    // No additional flood should have been sent
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('3.03 — re-origination is allowed after MinLSInterval (5s) has elapsed', () => {
    // First origination
    engine.originateRouterLSA(OSPF_BACKBONE_AREA);
    const countBefore = sentLSUs.filter(lsu => lsu.lsas.some(l => l.advertisingRouter === '1.1.1.1')).length;

    // Advance time past MinLSInterval (5 seconds = 5000ms)
    vi.advanceTimersByTime(OSPF_MIN_LS_INTERVAL * 1000);

    // Second origination (after interval)
    engine.originateRouterLSA(OSPF_BACKBONE_AREA);
    const countAfter = sentLSUs.filter(lsu => lsu.lsas.some(l => l.advertisingRouter === '1.1.1.1')).length;

    // A new flood should have been sent
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it('3.04 — foreign LSAs (from other routers) are not subject to MinLSInterval', () => {
    // Two LSUs from the same foreign router arriving back-to-back
    const foreignLsa1 = makeRouterLSA('9.9.9.9', OSPF_INITIAL_SEQUENCE_NUMBER, 0);
    const foreignLsa2 = makeRouterLSA('9.9.9.9', OSPF_INITIAL_SEQUENCE_NUMBER + 1, 0);

    // Simulate receiving via processLSUpdate (with a neighbor)
    const iface = engine.getInterface('eth0')!;
    const nbr = iface.neighbors.get('2.2.2.2')!;
    nbr.state = 'Full'; // already Full

    engine.installLSA(OSPF_BACKBONE_AREA, foreignLsa1);
    engine.installLSA(OSPF_BACKBONE_AREA, foreignLsa2);

    // Both should be installed (MinLSInterval doesn't apply to foreign LSAs)
    const lsa = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '9.9.9.9', '9.9.9.9')!;
    expect(lsa.lsSequenceNumber).toBe(OSPF_INITIAL_SEQUENCE_NUMBER + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: MinLSArrival (1s protection against LSA flood storms)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4 — MinLSArrival (1s flood protection)', () => {
  let engine: OSPFEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine('1.1.1.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
    // Add a fake Full neighbor
    const iface = engine.getInterface('eth0')!;
    iface.neighbors.set('2.2.2.2', makeFakeNeighbor('2.2.2.2', '10.0.0.2', 'eth0'));
    engine.setSendCallback(() => {}); // no-op send
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('4.01 — first arrival of a foreign LSA is installed', () => {
    const lsa = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER, 0);
    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsa, '2.2.2.2'));
    expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3')).toBeDefined();
  });

  it('4.02 — second arrival of same LSA (higher seq) within 1s is dropped (MinLSArrival)', () => {
    const lsa1 = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER, 0);
    const lsa2 = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER + 1, 0);

    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsa1, '2.2.2.2'));
    // Second arrival immediately (within 1s, no time advance)
    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsa2, '2.2.2.2'));

    // LSDB should still have the FIRST LSA (second was dropped)
    const installed = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3')!;
    expect(installed.lsSequenceNumber).toBe(OSPF_INITIAL_SEQUENCE_NUMBER);
  });

  it('4.03 — second arrival of same LSA after MinLSArrival (1s) is accepted', () => {
    const lsa1 = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER, 0);
    const lsa2 = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER + 1, 0);

    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsa1, '2.2.2.2'));

    // Advance past MinLSArrival (1 second)
    vi.advanceTimersByTime(OSPF_MIN_LS_ARRIVAL * 1000);

    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsa2, '2.2.2.2'));

    // LSDB should have the SECOND LSA now
    const installed = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3')!;
    expect(installed.lsSequenceNumber).toBe(OSPF_INITIAL_SEQUENCE_NUMBER + 1);
  });

  it('4.04 — different LSA (different linkStateId) is not rate-limited by a prior arrival', () => {
    const lsaA = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER, 0);
    const lsaB = makeRouterLSA('4.4.4.4', OSPF_INITIAL_SEQUENCE_NUMBER, 0);

    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsaA, '2.2.2.2'));
    // Different LSA — should be installed regardless of arrival time
    engine.processLSUpdate('eth0', '10.0.0.2', makeLSU(lsaB, '2.2.2.2'));

    expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3')).toBeDefined();
    expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '4.4.4.4', '4.4.4.4')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: SPF Throttle (exponential back-off)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5 — SPF Throttle (exponential back-off)', () => {
  let engine: OSPFEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = makeEngine('1.1.1.1');
    engine.activateInterface('eth0', '10.0.0.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('5.01 — setThrottleSPF stores initial/hold/max and getThrottleSPFConfig returns them', () => {
    engine.setThrottleSPF(100, 500, 8_000);
    const cfg = engine.getThrottleSPFConfig();
    expect(cfg.initial).toBe(100);
    expect(cfg.hold).toBe(500);
    expect(cfg.max).toBe(8_000);
  });

  it('5.02 — scheduleSPF uses initial delay for the very first SPF', () => {
    engine.setThrottleSPF(300, 1_000, 10_000);
    const spySPF = vi.spyOn(engine, 'runSPF');

    engine.scheduleSPF();
    expect(spySPF).not.toHaveBeenCalled(); // not yet

    vi.advanceTimersByTime(299);
    expect(spySPF).not.toHaveBeenCalled(); // still not

    vi.advanceTimersByTime(1);   // now at 300ms
    expect(spySPF).toHaveBeenCalledOnce();
  });

  it('5.03 — rapid re-schedule uses hold delay (not initial)', () => {
    engine.setThrottleSPF(100, 500, 10_000);
    const spySPF = vi.spyOn(engine, 'runSPF');

    // First SPF
    engine.scheduleSPF();
    vi.advanceTimersByTime(100);    // SPF #1 runs at T=100ms
    expect(spySPF).toHaveBeenCalledOnce();

    // Second schedule (rapid re-schedule — within max window)
    engine.scheduleSPF();
    vi.advanceTimersByTime(100);    // NOT enough — hold is 500ms
    expect(spySPF).toHaveBeenCalledOnce(); // still 1

    vi.advanceTimersByTime(400);    // Total +500ms from second schedule → SPF #2 runs
    expect(spySPF).toHaveBeenCalledTimes(2);
  });

  it('5.04 — hold doubles on each rapid re-schedule, capped at max', () => {
    engine.setThrottleSPF(50, 100, 400);
    const spySPF = vi.spyOn(engine, 'runSPF');

    // SPF #1 at T=50ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(50);
    expect(spySPF).toHaveBeenCalledTimes(1);

    // SPF #2: hold = 100ms → scheduled at T=50+100=150ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(100);
    expect(spySPF).toHaveBeenCalledTimes(2);

    // SPF #3: hold = 200ms → scheduled at T=150+200=350ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(200);
    expect(spySPF).toHaveBeenCalledTimes(3);

    // SPF #4: hold would be 400ms but max=400 → still 400ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(400);
    expect(spySPF).toHaveBeenCalledTimes(4);

    // SPF #5: hold = 400ms (capped) → scheduled +400ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(400);
    expect(spySPF).toHaveBeenCalledTimes(5);
  });

  it('5.05 — after quiet period (> max time since last SPF), hold resets to initial delay', () => {
    engine.setThrottleSPF(50, 200, 1_000);
    const spySPF = vi.spyOn(engine, 'runSPF');

    // SPF #1
    engine.scheduleSPF();
    vi.advanceTimersByTime(50);
    expect(spySPF).toHaveBeenCalledTimes(1);

    // SPF #2 (rapid) — uses hold=200ms
    engine.scheduleSPF();
    vi.advanceTimersByTime(200);
    expect(spySPF).toHaveBeenCalledTimes(2);

    // Quiet period: wait > max (1000ms) since last SPF
    vi.advanceTimersByTime(1_001);

    // SPF #3 after quiet period → should use initial=50ms again
    engine.scheduleSPF();
    vi.advanceTimersByTime(50);
    expect(spySPF).toHaveBeenCalledTimes(3);

    // Verify hold has reset: SPF #4 should again use hold=200ms (not doubled hold)
    engine.scheduleSPF();
    vi.advanceTimersByTime(50);    // NOT enough — hold is 200ms now
    expect(spySPF).toHaveBeenCalledTimes(3); // still 3

    vi.advanceTimersByTime(150);   // Total 200ms
    expect(spySPF).toHaveBeenCalledTimes(4);
  });
});
