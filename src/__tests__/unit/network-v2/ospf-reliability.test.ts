/**
 * OSPF Reliability TDD Test Suite — Step 3
 *
 * Tests covering the three remaining simulation gaps:
 *   1. MTU / Fragmentation  — DD, LSR, and LSU respect interface MTU
 *   2. LSA Checksum         — Fletcher-16 auto-compute and validation
 *   3. Network Delay        — propagationDelayMs defers packet delivery
 *
 * All tests use the real OSPFEngine sendCallback mechanism (no direct
 * LSDB copying).  Groups 1 and 2 run synchronously; Group 3 uses
 * vitest fake timers where asynchronous behaviour needs to be observed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OSPF_VERSION_2,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA,
  type OSPFHelloPacket,
  type OSPFDDPacket,
  type OSPFLSUpdatePacket,
  type OSPFLSRequestPacket,
  type RouterLSA,
  type OSPFInterface,
} from '@/network/ospf/types';
import {
  OSPFEngine,
  computeOSPFLSAChecksum,
  verifyOSPFLSAChecksum,
} from '@/network/ospf/OSPFEngine';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHello(
  routerId: string,
  opts: Partial<OSPFHelloPacket> = {},
): OSPFHelloPacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_2,
    packetType: 1,
    routerId,
    areaId: opts.areaId ?? OSPF_BACKBONE_AREA,
    networkMask: opts.networkMask ?? '255.255.255.0',
    helloInterval: opts.helloInterval ?? 10,
    options: opts.options ?? 0x02,
    priority: opts.priority ?? 1,
    deadInterval: opts.deadInterval ?? 40,
    designatedRouter: opts.designatedRouter ?? '0.0.0.0',
    backupDesignatedRouter: opts.backupDesignatedRouter ?? '0.0.0.0',
    neighbors: opts.neighbors ?? [],
  };
}

function makeRouterLSA(routerId: string, seqNum?: number): RouterLSA {
  return {
    lsAge: 0,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter: routerId,
    lsSequenceNumber: seqNum ?? OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0x1234, // arbitrary — installLSA must recompute
    length: 24,
    flags: 0,
    numLinks: 0,
    links: [],
  };
}

/** Create a P2P engine with configurable MTU and delay. */
function createEngine(
  routerId: string,
  ifaceIP: string,
  opts: { mtu?: number; propagationDelayMs?: number; ifName?: string } = {},
): { engine: OSPFEngine; iface: OSPFInterface } {
  const ifName = opts.ifName ?? 'eth0';
  const engine = new OSPFEngine();
  engine.setRouterId(routerId);
  engine.addNetwork('10.0.0.0', '0.255.255.255', OSPF_BACKBONE_AREA);
  const iface = engine.activateInterface(ifName, ifaceIP, '255.255.255.0', OSPF_BACKBONE_AREA, {
    networkType: 'point-to-point',
    mtu: opts.mtu,
    propagationDelayMs: opts.propagationDelayMs,
  });
  return { engine, iface };
}

/**
 * Wire two engines synchronously (no delay) and drive them to Full.
 * Slave fires TwoWayReceived before master so the chain runs synchronously.
 */
function wireAndDriveToFull(
  e1: OSPFEngine, ip1: string,
  e2: OSPFEngine, ip2: string,
  ifName1 = 'eth0', ifName2 = 'eth0',
): { sentByE1: OSPFDDPacket[]; sentByE2: OSPFDDPacket[]; lsrByE1: OSPFLSRequestPacket[]; lsrByE2: OSPFLSRequestPacket[] } {
  const sentByE1: OSPFDDPacket[] = [];
  const sentByE2: OSPFDDPacket[] = [];
  const lsrByE1: OSPFLSRequestPacket[] = [];
  const lsrByE2: OSPFLSRequestPacket[] = [];

  e1.setSendCallback((_if, pkt, _dest) => {
    if ((pkt as any).packetType === 2) sentByE1.push(pkt as OSPFDDPacket);
    if ((pkt as any).packetType === 3) lsrByE1.push(pkt as OSPFLSRequestPacket);
    e2.processPacket(ifName2, ip1, pkt);
  });
  e2.setSendCallback((_if, pkt, _dest) => {
    if ((pkt as any).packetType === 2) sentByE2.push(pkt as OSPFDDPacket);
    if ((pkt as any).packetType === 3) lsrByE2.push(pkt as OSPFLSRequestPacket);
    e1.processPacket(ifName1, ip2, pkt);
  });

  const rid1 = e1.getRouterId();
  const rid2 = e2.getRouterId();
  const masterEngine = rid1 > rid2 ? e1 : e2;
  const slaveEngine  = rid1 > rid2 ? e2 : e1;
  const masterRid    = rid1 > rid2 ? rid1 : rid2;
  const slaveRid     = rid1 > rid2 ? rid2 : rid1;
  const masterIP     = rid1 > rid2 ? ip1 : ip2;
  const slaveIP      = rid1 > rid2 ? ip2 : ip1;
  const masterIfName = rid1 > rid2 ? ifName1 : ifName2;
  const slaveIfName  = rid1 > rid2 ? ifName2 : ifName1;

  // Slave first: fires TwoWayReceived → ExStart, sends INIT (no MASTER)
  slaveEngine.processHello(slaveIfName, masterIP, makeHello(masterRid, { neighbors: [slaveRid] }));
  // Master: fires TwoWayReceived → ExStart → sends INIT|MASTER → chain completes
  masterEngine.processHello(masterIfName, slaveIP, makeHello(slaveRid, { neighbors: [masterRid] }));

  return { sentByE1, sentByE2, lsrByE1, lsrByE2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — MTU / Fragmentation
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — MTU / Fragmentation', () => {

  it('1.1 — default interface MTU is 1500 and propagationDelayMs is 0', () => {
    const { iface } = createEngine('1.1.1.1', '10.0.0.1');
    expect(iface.mtu).toBe(1500);
    expect(iface.propagationDelayMs).toBe(0);
  });

  it('1.2 — sendDDWithSummary respects MTU: fewer headers per DD with smaller MTU', () => {
    // MTU=100 → maxHeaders = floor((100-32)/20) = 3
    const { engine: eA, iface: ifA } = createEngine('2.2.2.2', '10.0.0.1', { mtu: 100 });
    const { engine: eB } = createEngine('1.1.1.1', '10.0.0.2');

    // Install 6 LSAs in master (eA)
    for (let i = 1; i <= 6; i++) {
      eA.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(`192.168.${i}.1`));
    }

    const ddFromA: OSPFDDPacket[] = [];
    eA.setSendCallback((_if, pkt, _dest) => {
      if ((pkt as any).packetType === 2) ddFromA.push(pkt as OSPFDDPacket);
      eB.processPacket('eth0', '10.0.0.1', pkt);
    });
    eB.setSendCallback((_if, pkt, _dest) => {
      eA.processPacket('eth0', '10.0.0.2', pkt);
    });

    // Slave first, then master
    eB.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    eA.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Exchange DDs from master (eA) should have ≤3 headers each (MTU=100)
    const exchangeDDs = ddFromA.filter(d => (d.flags & 0x04) === 0); // not INIT
    expect(exchangeDDs.length).toBeGreaterThan(0);
    for (const dd of exchangeDDs) {
      expect(dd.lsaHeaders.length).toBeLessThanOrEqual(3);
    }
  });

  it('1.3 — sendLSRequest respects MTU: fewer requests per LSR with smaller MTU', () => {
    // MTU=96 → maxRequests = floor((96-24)/12) = 6
    const { engine: eA } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: eB } = createEngine('1.1.1.1', '10.0.0.2', { mtu: 96 });

    // Install 9 LSAs only in master (eA) so slave (eB) will need to request them
    for (let i = 1; i <= 9; i++) {
      eA.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(`192.168.${i}.1`));
    }

    const { lsrByE2 } = wireAndDriveToFull(eA, '10.0.0.1', eB, '10.0.0.2');

    // Each LSR from slave (eB) should have ≤6 requests
    expect(lsrByE2.length).toBeGreaterThan(0);
    for (const lsr of lsrByE2) {
      expect(lsr.requests.length).toBeLessThanOrEqual(6);
    }
  });

  it('1.4 — processLSRequest fragments LSU into multiple packets when LSAs exceed MTU', () => {
    // MTU=100 → LSU overhead=28, each 0-link RouterLSA length=24
    //   maxPerLSU = floor((100-28)/24) = 3
    const { engine, iface } = createEngine('1.1.1.1', '10.0.0.1', { mtu: 100 });

    // Install 9 LSAs
    for (let i = 1; i <= 9; i++) {
      engine.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(`192.168.${i}.1`));
    }

    // Set up a fake neighbor in Full state so processLSRequest works
    // (it only needs a neighbor with the correct srcIP)
    engine.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: [] }));
    const neighbor = iface.neighbors.get('2.2.2.2')!;
    expect(neighbor).toBeDefined();
    // Force neighbor to Full (bypass state machine for this direct call test)
    (neighbor as any).state = 'Full';

    const lsuPackets: OSPFLSUpdatePacket[] = [];
    engine.setSendCallback((_if, pkt, _dest) => {
      if ((pkt as any).packetType === 4) lsuPackets.push(pkt as OSPFLSUpdatePacket);
    });

    // Send LSR requesting all 9 LSAs
    const requests = Array.from({ length: 9 }, (_, i) => ({
      lsType: 1 as const,
      linkStateId: `192.168.${i + 1}.1`,
      advertisingRouter: `192.168.${i + 1}.1`,
    }));
    engine.processLSRequest('eth0', '10.0.0.2', {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 3,
      routerId: '2.2.2.2',
      areaId: OSPF_BACKBONE_AREA,
      requests,
    });

    // With MTU=100: maxPerLSU=3, expect at least 3 LSU packets for 9 LSAs
    expect(lsuPackets.length).toBeGreaterThanOrEqual(3);
    for (const lsu of lsuPackets) {
      expect(lsu.lsas.length).toBeLessThanOrEqual(3);
    }
    // All 9 LSAs must be delivered across the fragments
    const deliveredKeys = lsuPackets.flatMap(l => l.lsas.map(a => a.linkStateId));
    expect(deliveredKeys).toHaveLength(9);
  });

  it('1.5 — all LSAs received despite MTU-fragmented LSR/LSU exchange', () => {
    // eA has 9 LSAs, eB has none. MTU=96 on eB → maxRequests=6 per LSR.
    // After re-triggering, eB should end up with all 9 LSAs in its LSDB.
    const { engine: eA } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: eB } = createEngine('1.1.1.1', '10.0.0.2', { mtu: 96 });

    for (let i = 1; i <= 9; i++) {
      eA.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA(`192.168.${i}.1`));
    }

    wireAndDriveToFull(eA, '10.0.0.1', eB, '10.0.0.2');

    // Verify eB has all 9 LSAs
    for (let i = 1; i <= 9; i++) {
      const lsa = eB.lookupLSA(OSPF_BACKBONE_AREA, 1, `192.168.${i}.1`, `192.168.${i}.1`);
      expect(lsa).toBeDefined();
    }
    // Verify neighbor reached Full
    const nb = eB.getInterface('eth0')!.neighbors.get('2.2.2.2');
    expect(nb?.state).toBe('Full');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — LSA Checksum (Fletcher-16)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — LSA Checksum (Fletcher-16)', () => {

  it('2.1 — computeOSPFLSAChecksum returns non-zero for a valid Router-LSA', () => {
    const lsa = makeRouterLSA('1.1.1.1');
    const checksum = computeOSPFLSAChecksum(lsa);
    expect(checksum).toBeGreaterThan(0);
    expect(checksum).toBeLessThanOrEqual(0xFFFF);
  });

  it('2.2 — computeOSPFLSAChecksum is deterministic', () => {
    const lsa = makeRouterLSA('2.2.2.2');
    const c1 = computeOSPFLSAChecksum(lsa);
    const c2 = computeOSPFLSAChecksum(lsa);
    expect(c1).toBe(c2);
  });

  it('2.3 — verifyOSPFLSAChecksum returns true when checksum matches', () => {
    const lsa = makeRouterLSA('3.3.3.3');
    lsa.checksum = computeOSPFLSAChecksum(lsa);
    expect(verifyOSPFLSAChecksum(lsa)).toBe(true);
  });

  it('2.4 — verifyOSPFLSAChecksum returns false when checksum is wrong', () => {
    const lsa = makeRouterLSA('4.4.4.4');
    lsa.checksum = 0xDEAD; // intentionally wrong
    expect(verifyOSPFLSAChecksum(lsa)).toBe(false);
  });

  it('2.5 — installLSA auto-computes and stores a valid checksum', () => {
    const { engine } = createEngine('1.1.1.1', '10.0.0.1');
    const lsa = makeRouterLSA('5.5.5.5'); // checksum = 0x1234 initially
    engine.installLSA(OSPF_BACKBONE_AREA, lsa);

    const stored = engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '5.5.5.5', '5.5.5.5');
    expect(stored).toBeDefined();
    expect(stored!.checksum).not.toBe(0x1234);
    expect(verifyOSPFLSAChecksum(stored!)).toBe(true);
  });

  it('2.6 — processLSUpdate rejects an LSA with a wrong checksum', () => {
    const { engine: eA } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: eB } = createEngine('1.1.1.1', '10.0.0.2');

    // Wire and drive to Full so both engines have valid Full neighbors
    wireAndDriveToFull(eA, '10.0.0.1', eB, '10.0.0.2');

    // Craft an LSA with a wrong checksum
    const badLSA: RouterLSA = {
      lsAge: 0, options: 0x02, lsType: 1,
      linkStateId: '9.9.9.9', advertisingRouter: '9.9.9.9',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0xBAD0, // intentionally wrong
      length: 24, flags: 0, numLinks: 0, links: [],
    };

    // Deliver directly to eB (srcIP = eA's IP)
    eB.processLSUpdate('eth0', '10.0.0.1', {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 4,
      routerId: '2.2.2.2',
      areaId: OSPF_BACKBONE_AREA,
      numLSAs: 1,
      lsas: [badLSA],
    });

    // eB should NOT have installed the LSA with the bad checksum
    expect(eB.lookupLSA(OSPF_BACKBONE_AREA, 1, '9.9.9.9', '9.9.9.9')).toBeUndefined();
  });

  it('2.7 — processLSUpdate accepts LSA with valid checksum, stored with valid checksum', () => {
    const { engine: eA } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: eB } = createEngine('1.1.1.1', '10.0.0.2');

    // Pre-install an LSA in eA (installLSA auto-computes checksum)
    eA.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('7.7.7.7'));

    wireAndDriveToFull(eA, '10.0.0.1', eB, '10.0.0.2');

    // eB should have received eA's LSA via LSU during Loading phase
    const received = eB.lookupLSA(OSPF_BACKBONE_AREA, 1, '7.7.7.7', '7.7.7.7');
    expect(received).toBeDefined();
    // The stored checksum must be valid
    expect(verifyOSPFLSAChecksum(received!)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — Network Delay Simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — Network Delay Simulation', () => {

  afterEach(() => {
    vi.useRealTimers();
  });

  it('3.1 — propagationDelayMs defaults to 0 on a freshly activated interface', () => {
    const { iface } = createEngine('1.1.1.1', '10.0.0.1');
    expect(iface.propagationDelayMs).toBe(0);
  });

  it('3.2 — propagationDelayMs can be set to a custom value via activateInterface options', () => {
    const { iface } = createEngine('1.1.1.1', '10.0.0.1', { propagationDelayMs: 50 });
    expect(iface.propagationDelayMs).toBe(50);
  });

  it('3.3 — zero delay: Full adjacency reached synchronously without any timer', () => {
    // eA=master ('2.2.2.2' > '1.1.1.1'), eB=slave.
    // Zero delay means the entire ExStart→Full chain runs within the call stack.
    const { engine: eA } = createEngine('2.2.2.2', '10.0.0.1', { propagationDelayMs: 0 });
    const { engine: eB, iface: ifB } = createEngine('1.1.1.1', '10.0.0.2', { propagationDelayMs: 0 });

    eA.setSendCallback((_if, pkt, _dest) => eB.processPacket('eth0', '10.0.0.1', pkt));
    eB.setSendCallback((_if, pkt, _dest) => eA.processPacket('eth0', '10.0.0.2', pkt));

    // Slave-first: eB processes eA's hello → TwoWayReceived → ExStart
    eB.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    // Master: eA processes eB's hello → TwoWayReceived → ExStart → sends INIT|MASTER
    //         → eB receives synchronously (no setTimeout) → chain completes immediately
    eA.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Zero-delay: Full state reached inside the processHello call above
    expect(ifB.neighbors.has('2.2.2.2')).toBe(true);
    expect(ifB.neighbors.get('2.2.2.2')!.state).toBe('Full');
  });

  it('3.4 — non-zero delay: packet deferred; Full state reached only after timer fires', () => {
    vi.useFakeTimers();

    // eA=master ('2.2.2.2'>'1.1.1.1'), delay=100ms on eA's outgoing packets.
    const { engine: eA, iface: ifA } = createEngine('2.2.2.2', '10.0.0.1', { propagationDelayMs: 100 });
    const { engine: eB, iface: ifB } = createEngine('1.1.1.1', '10.0.0.2');

    let packetsDeliveredToB = 0;

    // eA's callback wraps delivery in setTimeout (simulating propagation delay)
    eA.setSendCallback((_ifName, pkt, _dest) => {
      const delay = ifA.propagationDelayMs;
      setTimeout(() => {
        packetsDeliveredToB++;
        eB.processPacket('eth0', '10.0.0.1', pkt);
      }, delay);
    });
    // eB's callback is synchronous (no delay in this direction)
    eB.setSendCallback((_if, pkt, _dest) => {
      eA.processPacket('eth0', '10.0.0.2', pkt);
    });

    // Slave-first: eB sends INIT (no MASTER) synchronously → eA has no neighbor yet → dropped
    eB.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    // Master: eA sends INIT|MASTER but it is deferred by 100 ms
    eA.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Immediately after: eB is in ExStart (waiting for master), INIT|MASTER not yet delivered
    expect(packetsDeliveredToB).toBe(0);
    expect(ifB.neighbors.get('2.2.2.2')!.state).toBe('ExStart');

    // Advance time past two propagation delays (INIT|MASTER + Exchange DD from eA)
    // to let the full ExStart→Exchange→Full chain complete.
    vi.advanceTimersByTime(300);

    expect(packetsDeliveredToB).toBeGreaterThan(0);
    expect(ifB.neighbors.get('2.2.2.2')!.state).toBe('Full');
  });
});
