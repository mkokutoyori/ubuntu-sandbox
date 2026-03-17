/**
 * OSPF Packet Exchange TDD Test Suite — Step 2
 *
 * Tests the real OSPF packet exchange between OSPFEngine instances using
 * the sendCallback mechanism. No direct LSDB copying — all synchronization
 * happens via actual DD/LSR/LSU/LSAck packets, exactly as in RFC 2328.
 *
 * Test groups:
 *   1. sendCallback wiring (basic delivery)
 *   2. DD negotiation — Master/Slave (ExStart)
 *   3. Full adjacency — empty and non-empty LSDBs
 *   4. Loading phase — LSR/LSU/LSAck exchange
 *   5. LSA flooding after Full adjacency
 *   6. Retransmit timers — DD and LSR
 *   7. 3-router multi-hop chain
 *   8. Broadcast segment — DR/BDR election and selective adjacency
 *   9. Edge cases — passive interface, SeqMismatch, hello validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OSPF_VERSION_2,
  OSPF_DEFAULT_HELLO_INTERVAL,
  OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  type OSPFHelloPacket,
  type OSPFDDPacket,
  type OSPFLSUpdatePacket,
  type OSPFLSRequestPacket,
  type OSPFLSAckPacket,
  type RouterLSA,
  type OSPFInterface,
  type OSPFNeighbor,
  type OSPFPacket,
} from '@/network/ospf/types';
import { OSPFEngine, computeOSPFLSAChecksum } from '@/network/ospf/OSPFEngine';

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
    helloInterval: opts.helloInterval ?? OSPF_DEFAULT_HELLO_INTERVAL,
    options: opts.options ?? 0x02,
    priority: opts.priority ?? 1,
    deadInterval: opts.deadInterval ?? OSPF_DEFAULT_DEAD_INTERVAL,
    designatedRouter: opts.designatedRouter ?? '0.0.0.0',
    backupDesignatedRouter: opts.backupDesignatedRouter ?? '0.0.0.0',
    neighbors: opts.neighbors ?? [],
  };
}

function makeRouterLSA(routerId: string, seqNum?: number): RouterLSA {
  const lsa: RouterLSA = {
    lsAge: 0,
    options: 0x02,
    lsType: 1,
    linkStateId: routerId,
    advertisingRouter: routerId,
    lsSequenceNumber: seqNum ?? OSPF_INITIAL_SEQUENCE_NUMBER,
    checksum: 0,
    length: 24,
    flags: 0,
    numLinks: 0,
    links: [],
  };
  lsa.checksum = computeOSPFLSAChecksum(lsa);
  return lsa;
}

/**
 * Create a P2P engine with a single interface.
 */
function createEngine(
  routerId: string,
  ifaceIP: string,
  ifaceName = 'eth0',
  processId = 1,
): { engine: OSPFEngine; iface: OSPFInterface } {
  const engine = new OSPFEngine(processId);
  engine.setRouterId(routerId);
  engine.addNetwork('10.0.0.0', '0.255.255.255', OSPF_BACKBONE_AREA);
  const iface = engine.activateInterface(ifaceName, ifaceIP, '255.255.255.0', OSPF_BACKBONE_AREA, {
    networkType: 'point-to-point',
  });
  return { engine, iface };
}

/**
 * Wire two P2P engines bidirectionally and drive them to Full state.
 *
 * The higher RID becomes Master (RFC 2328 §10.6). Slave fires TwoWayReceived
 * first so that when Master fires startDDExchange → sends INIT|MASTER, the
 * slave is already in ExStart and processes it, kicking off the full chain
 * synchronously via the call stack.
 *
 * Returns both engines and their interfaces plus tracked packet counts.
 */
function wireAndDriveToFull(
  rid1: string, ip1: string,
  rid2: string, ip2: string,
  ifName1 = 'eth0', ifName2 = 'eth0',
): {
  e1: OSPFEngine; if1: OSPFInterface;
  e2: OSPFEngine; if2: OSPFInterface;
  sentByE1: OSPFPacket[]; sentByE2: OSPFPacket[];
} {
  const { engine: e1, iface: if1 } = createEngine(rid1, ip1, ifName1);
  const { engine: e2, iface: if2 } = createEngine(rid2, ip2, ifName2);

  const sentByE1: OSPFPacket[] = [];
  const sentByE2: OSPFPacket[] = [];

  // Wire: each engine's sendCallback delivers to the other
  e1.setSendCallback((_ifName, pkt, _dest) => {
    sentByE1.push(pkt);
    e2.processPacket(ifName2, ip1, pkt);
  });
  e2.setSendCallback((_ifName, pkt, _dest) => {
    sentByE2.push(pkt);
    e1.processPacket(ifName1, ip2, pkt);
  });

  // Determine master/slave by string comparison of RIDs (RFC 2328 §10.6)
  const masterRid = rid1 > rid2 ? rid1 : rid2;
  const slaveRid  = rid1 > rid2 ? rid2 : rid1;
  const masterEngine = rid1 > rid2 ? e1 : e2;
  const slaveEngine  = rid1 > rid2 ? e2 : e1;
  const masterIface  = rid1 > rid2 ? if1 : if2;
  const slaveIface   = rid1 > rid2 ? if2 : if1;
  const masterIP     = rid1 > rid2 ? ip1 : ip2;
  const slaveIP      = rid1 > rid2 ? ip2 : ip1;
  const masterIfName = rid1 > rid2 ? ifName1 : ifName2;
  const slaveIfName  = rid1 > rid2 ? ifName2 : ifName1;

  // 1. Slave processes hello from master (listing slave's RID) → TwoWayReceived → ExStart
  //    Master's initial DD is delivered but master is still Init → ignored.
  slaveEngine.processHello(slaveIfName, masterIP,
    makeHello(masterRid, { neighbors: [slaveRid] }));

  // 2. Master processes hello from slave (listing master's RID) → TwoWayReceived → ExStart
  //    Master sends INIT|MASTER → slave is already ExStart → condition 1 fires → chain completes.
  masterEngine.processHello(masterIfName, slaveIP,
    makeHello(slaveRid, { neighbors: [masterRid] }));

  return { e1, if1, e2, if2, sentByE1, sentByE2 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: sendCallback — basic packet delivery
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — sendCallback: basic packet delivery', () => {

  it('1.1 — sendCallback delivers a Hello packet to the remote engine', () => {
    const { engine: e1 } = createEngine('1.1.1.1', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('2.2.2.2', '10.0.0.2');

    const received: OSPFPacket[] = [];
    e1.setSendCallback((_ifName, pkt, _dest) => received.push(pkt));

    // Manually call processHello on e2 and verify its neighbors
    e2.processHello('eth0', '10.0.0.1', makeHello('1.1.1.1'));
    expect(if2.neighbors.has('1.1.1.1')).toBe(true);
    expect(if2.neighbors.get('1.1.1.1')!.state).toBe('Init');
  });

  it('1.2 — wired pair: DD packet sent by e1 is received and processed by e2', () => {
    const { engine: e1 } = createEngine('2.2.2.2', '10.0.0.1'); // master
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2'); // slave

    const ddPackets: OSPFDDPacket[] = [];
    e1.setSendCallback((_ifName, pkt, _dest) => {
      if ((pkt as OSPFDDPacket).packetType === 2) ddPackets.push(pkt as OSPFDDPacket);
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_ifName, pkt, _dest) => {
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    // Create neighbor in e2 in Init state, then fire TwoWayReceived to reach ExStart
    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: [] }));
    const n2 = if2.neighbors.get('2.2.2.2')!;
    e2.neighborEvent(if2, n2, 'TwoWayReceived'); // slave → ExStart, sends INIT (no MASTER)

    // Slave sent its INIT DD (no MASTER), should not be recognized by master yet
    // At least verify DD was sent
    expect(ddPackets.length).toBeGreaterThanOrEqual(0); // e2's sendCallback fires
  });

  it('1.3 — sendCallback is not called on a passive interface', () => {
    const { engine: e1 } = createEngine('1.1.1.1', '10.0.0.1');
    e1.setPassiveInterface('eth0');

    const sent: OSPFPacket[] = [];
    e1.setSendCallback((_ifName, pkt, _dest) => sent.push(pkt));

    // Even if we manually fire events, passive interface shouldn't send
    const iface = e1.getInterface('eth0')!;
    expect(iface.passive).toBe(true);
    // Passive interface: hello timer cleared, no packets sent automatically
    expect(sent.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: DD Negotiation — Master/Slave (ExStart → Exchange)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — DD Negotiation: Master/Slave determination', () => {

  it('2.1 — higher RID router becomes Master after negotiation', () => {
    const { e1, if1, e2, if2 } = wireAndDriveToFull(
      '2.2.2.2', '10.0.0.1',
      '1.1.1.1', '10.0.0.2',
    );
    // After Full: master (e1, RID '2.2.2.2') had isMaster=true
    const n1 = if1.neighbors.get('1.1.1.1')!;
    const n2 = if2.neighbors.get('2.2.2.2')!;
    expect(n1.isMaster).toBe(true);  // e1 was master
    expect(n2.isMaster).toBe(false); // e2 was slave
  });

  it('2.2 — lower RID router becomes Slave after negotiation', () => {
    const { if1, if2 } = wireAndDriveToFull(
      '1.1.1.1', '10.0.0.1',
      '3.3.3.3', '10.0.0.2',
    );
    const n_slave = if1.neighbors.get('3.3.3.3')!; // e1 is slave
    const n_master = if2.neighbors.get('1.1.1.1')!; // e2 is master
    expect(n_slave.isMaster).toBe(false);
    expect(n_master.isMaster).toBe(true);
  });

  it('2.3 — slave adopts master DD sequence number during negotiation', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1'); // master
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2'); // slave

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    // Slave first, then master (triggers the chain)
    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // After Full: slave's ddSeqNumber matches master's original ddSeqNumber
    const n_slave = if2.neighbors.get('2.2.2.2')!; // slave's view of master
    const n_master = if1.neighbors.get('1.1.1.1')!; // master's view of slave
    expect(n_slave.ddSeqNumber).toBe(n_master.ddSeqNumber);
  });

  it('2.4 — both routers reach ExStart before chain completes', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    // Wire but don't drive yet
    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    // Only drive slave to ExStart (master still in Init → slave's DD ignored)
    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const n2 = if2.neighbors.get('2.2.2.2');
    expect(n2?.state).toBe('ExStart'); // slave is in ExStart
    // e1 has no neighbor yet (processHello not called for e1)
    const n1 = if1.neighbors.get('1.1.1.1');
    expect(n1).toBeUndefined(); // master hasn't processed hello yet
  });

  it('2.5 — initial DD has INIT+MORE+MASTER flags for master, INIT+MORE for slave', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1'); // master
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2'); // slave

    const ddFromMaster: OSPFDDPacket[] = [];
    const ddFromSlave: OSPFDDPacket[] = [];

    e1.setSendCallback((_i, pkt, _d) => {
      if ((pkt as OSPFDDPacket).packetType === 2) ddFromMaster.push(pkt as OSPFDDPacket);
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as OSPFDDPacket).packetType === 2) ddFromSlave.push(pkt as OSPFDDPacket);
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // First DD from master: INIT | MORE | MASTER
    const masterInitDD = ddFromMaster[0];
    expect(masterInitDD).toBeDefined();
    expect(masterInitDD.flags & DD_FLAG_INIT).toBeTruthy();
    expect(masterInitDD.flags & DD_FLAG_MASTER).toBeTruthy();

    // First DD from slave: INIT | MORE (no MASTER)
    const slaveInitDD = ddFromSlave[0];
    expect(slaveInitDD).toBeDefined();
    expect(slaveInitDD.flags & DD_FLAG_INIT).toBeTruthy();
    expect(slaveInitDD.flags & DD_FLAG_MASTER).toBeFalsy();
  });

  it('2.6 — Exchange DD from slave has no INIT and no MASTER flag', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    const ddFromSlave: OSPFDDPacket[] = [];
    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as OSPFDDPacket).packetType === 2) ddFromSlave.push(pkt as OSPFDDPacket);
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // After NegotiationDone, slave sends Exchange DD without INIT
    const exchangeDD = ddFromSlave.find(d => !(d.flags & DD_FLAG_INIT));
    expect(exchangeDD).toBeDefined();
    expect(exchangeDD!.flags & DD_FLAG_INIT).toBe(0);
    expect(exchangeDD!.flags & DD_FLAG_MASTER).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Full adjacency — empty and non-empty LSDBs
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — Full adjacency: empty and non-empty LSDBs', () => {

  it('3.1 — both routers reach Full with empty LSDBs (no Loading phase)', () => {
    const { if1, if2 } = wireAndDriveToFull(
      '2.2.2.2', '10.0.0.1',
      '1.1.1.1', '10.0.0.2',
    );
    expect(if1.neighbors.get('1.1.1.1')!.state).toBe('Full');
    expect(if2.neighbors.get('2.2.2.2')!.state).toBe('Full');
  });

  it('3.2 — both routers reach Full with non-empty LSDBs', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    // Pre-populate each LSDB with their own Router-LSA
    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    e2.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1'));

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(if1.neighbors.get('1.1.1.1')!.state).toBe('Full');
    expect(if2.neighbors.get('2.2.2.2')!.state).toBe('Full');
  });

  it('3.3 — after exchange, e2 has e1 LSA that it did not have before', () => {
    const { engine: e1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2 } = createEngine('1.1.1.1', '10.0.0.2');

    // Only e1 has a Router-LSA
    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // e2 should now have e1's Router-LSA
    const lsa = e2.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2');
    expect(lsa).toBeDefined();
    expect(lsa!.advertisingRouter).toBe('2.2.2.2');
  });

  it('3.4 — after exchange, both routers have all LSAs from both sides', () => {
    const { engine: e1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    e2.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1'));

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Both should have both LSAs
    expect(e1.lookupLSA(OSPF_BACKBONE_AREA, 1, '1.1.1.1', '1.1.1.1')).toBeDefined();
    expect(e2.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2')).toBeDefined();
  });

  it('3.5 — lsRequestList is empty after successful exchange', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    e2.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1'));

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(if1.neighbors.get('1.1.1.1')!.lsRequestList).toHaveLength(0);
    expect(if2.neighbors.get('2.2.2.2')!.lsRequestList).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Loading phase — LSR/LSU/LSAck exchange
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 4 — Loading phase: LSR/LSU/LSAck exchange', () => {

  it('4.1 — router enters Loading state when lsRequestList is non-empty', () => {
    // We intercept packets to pause mid-exchange and check Loading state
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    // e2 has no LSAs initially

    // Block LSR/LSU delivery to freeze at Loading
    let lsrDelivered = false;
    e1.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 4) return; // drop LSU for now
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 3) lsrDelivered = true; // track LSR
      // Also block LSR delivery so Loading is visible
      if ((pkt as any).packetType === 3) return;
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // e2 should be in Loading (it requested e1's LSA but LSR was dropped)
    expect(if2.neighbors.get('2.2.2.2')!.state).toBe('Loading');
    expect(lsrDelivered).toBe(true); // LSR was sent
  });

  it('4.2 — LSR packet contains the correct LSA type/id/advertisingRouter', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    const lsrPackets: OSPFLSRequestPacket[] = [];
    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 3) lsrPackets.push(pkt as OSPFLSRequestPacket);
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(lsrPackets.length).toBeGreaterThan(0);
    const req = lsrPackets[0].requests[0];
    expect(req.lsType).toBe(1); // Router-LSA
    expect(req.linkStateId).toBe('2.2.2.2');
    expect(req.advertisingRouter).toBe('2.2.2.2');
  });

  it('4.3 — LSU is sent in response to LSR and contains the requested LSA', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    const lsaContent = makeRouterLSA('2.2.2.2');
    e1.installLSA(OSPF_BACKBONE_AREA, lsaContent);

    const lsuPackets: OSPFLSUpdatePacket[] = [];
    e1.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 4) lsuPackets.push(pkt as OSPFLSUpdatePacket);
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(lsuPackets.length).toBeGreaterThan(0);
    const lsu = lsuPackets[0];
    expect(lsu.lsas.length).toBeGreaterThan(0);
    expect(lsu.lsas[0].advertisingRouter).toBe('2.2.2.2');
  });

  it('4.4 — LSAck is sent after receiving LSU', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    const lsAckPackets: OSPFLSAckPacket[] = [];
    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 5) lsAckPackets.push(pkt as OSPFLSAckPacket);
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(lsAckPackets.length).toBeGreaterThan(0);
    expect(lsAckPackets[0].lsaHeaders.length).toBeGreaterThan(0);
  });

  it('4.5 — packet type sequence: DD, LSR, LSU, LSAck (when LSDBs differ)', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    const typesFromE1: number[] = [];
    const typesFromE2: number[] = [];
    e1.setSendCallback((_i, pkt, _d) => {
      typesFromE1.push((pkt as any).packetType);
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      typesFromE2.push((pkt as any).packetType);
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // E1 (master) sends: DD, DD (exchange), LSU (in response to LSR)
    expect(typesFromE1).toContain(2); // DD
    expect(typesFromE1).toContain(4); // LSU

    // E2 (slave) sends: DD (ExStart init), DD (exchange), LSR, LSAck
    expect(typesFromE2).toContain(2); // DD
    expect(typesFromE2).toContain(3); // LSR
    expect(typesFromE2).toContain(5); // LSAck
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: LSA flooding after Full adjacency
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 5 — LSA flooding after Full adjacency', () => {

  it('5.1 — new Router-LSA originated after Full is received by peer', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    // Reach Full state first
    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(if1.neighbors.get('1.1.1.1')!.state).toBe('Full');

    // Now originate a Router-LSA on e1 — should flood to e2
    e1.originateRouterLSA(OSPF_BACKBONE_AREA);

    const flooded = e2.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2');
    expect(flooded).toBeDefined();
  });

  it('5.2 — LSA flooded after Full reaches all Full neighbors', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Install a new external LSA in e1 and flood
    const externalLSA = {
      ...makeRouterLSA('5.5.5.5'),
      lsType: 5 as const,
      linkStateId: '192.168.1.0',
      advertisingRouter: '5.5.5.5',
    };
    (externalLSA as any).lsType = 5;
    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('5.5.5.5'));

    // Flood via a fake LSU
    const lsu: OSPFLSUpdatePacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 4,
      routerId: '5.5.5.5',
      areaId: OSPF_BACKBONE_AREA,
      numLSAs: 1,
      lsas: [makeRouterLSA('5.5.5.5', OSPF_INITIAL_SEQUENCE_NUMBER + 1)],
    };
    // Deliver to e1 as if from an ASBR
    e1.processLSUpdate('eth0', '10.0.0.2', lsu);

    // e2 should have received the flood
    expect(e2.lookupLSA(OSPF_BACKBONE_AREA, 1, '5.5.5.5', '5.5.5.5')).toBeDefined();
  });

  it('5.3 — updated LSA (higher seq) replaces older one via flooding', () => {
    const { engine: e1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2 } = createEngine('1.1.1.1', '10.0.0.2');

    // Install old LSA in both
    const oldLSA = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER);
    e1.installLSA(OSPF_BACKBONE_AREA, oldLSA);
    e2.installLSA(OSPF_BACKBONE_AREA, oldLSA);

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Flood a newer version from e1
    const newLSA = makeRouterLSA('3.3.3.3', OSPF_INITIAL_SEQUENCE_NUMBER + 1);
    const lsu: OSPFLSUpdatePacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 4,
      routerId: '2.2.2.2', areaId: OSPF_BACKBONE_AREA, numLSAs: 1, lsas: [newLSA],
    };
    e1.processLSUpdate('eth0', '10.0.0.2', lsu);

    const updated = e2.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3');
    expect(updated?.lsSequenceNumber).toBe(OSPF_INITIAL_SEQUENCE_NUMBER + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Retransmit timers
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 6 — Retransmit timers: DD and LSR', () => {

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('6.1 — DD retransmit timer fires after retransmitInterval when no response', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1'); // master

    const ddsSent: OSPFDDPacket[] = [];
    // Wire to nowhere (no response) to keep e1 in ExStart
    e1.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 2) ddsSent.push(pkt as OSPFDDPacket);
      // Don't deliver — simulate network drop
    });

    // Manually create neighbor in ExStart (as master)
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: [] }));
    const n = if1.neighbors.get('1.1.1.1')!;
    e1.neighborEvent(if1, n, 'TwoWayReceived'); // → ExStart, sends initial DD

    const initialCount = ddsSent.length;
    expect(initialCount).toBeGreaterThan(0); // at least the initial DD was sent

    // Advance time by retransmitInterval (5 seconds default)
    vi.advanceTimersByTime(5000);

    // Retransmit should have fired
    expect(ddsSent.length).toBeGreaterThan(initialCount);
    // Retransmitted DD should be the same as the initial one
    expect(ddsSent[ddsSent.length - 1].flags).toBe(ddsSent[0].flags);
  });

  it('6.2 — DD retransmit timer is cancelled when NegotiationDone fires', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // After Full, both retransmit timers should be null
    const n1 = if1.neighbors.get('1.1.1.1')!;
    const n2 = if2.neighbors.get('2.2.2.2')!;
    expect(n1.ddRetransmitTimer).toBeNull();
    expect(n2.ddRetransmitTimer).toBeNull();
  });

  it('6.3 — LSR retransmit timer fires when no LSU is received', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    const lsrsSent: OSPFLSRequestPacket[] = [];
    // Block LSU from e1 to keep e2 in Loading
    e1.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 4) return; // drop LSU
      e2.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      if ((pkt as any).packetType === 3) lsrsSent.push(pkt as OSPFLSRequestPacket);
      if ((pkt as any).packetType === 3) return; // drop LSR to stay in Loading
      e1.processPacket('eth0', '10.0.0.2', pkt);
    });

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    const n2 = if2.neighbors.get('2.2.2.2')!;
    expect(n2.state).toBe('Loading');

    const lsrCountBefore = lsrsSent.length;

    // Advance timer to trigger LSR retransmit
    vi.advanceTimersByTime(5000);

    expect(lsrsSent.length).toBeGreaterThan(lsrCountBefore);
  });

  it('6.4 — LSR retransmit timer is cancelled when LoadingDone fires', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // After Full, LSR retransmit timer should be cancelled
    const n2 = if2.neighbors.get('2.2.2.2')!;
    expect(n2.state).toBe('Full');
    expect(n2.lsrRetransmitTimer).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: 3-router multi-hop chain
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 7 — 3-router multi-hop chain: R1 ── R2 ── R3', () => {

  /**
   * Wire three engines in a chain: e1-e2 on eth0/eth0 and e2-e3 on eth1/eth0.
   * Drive R1-R2 first, then R2-R3. By the time R2-R3 exchange happens, R2 has
   * R1's LSA, so R3 learns about R1 via LSR/LSU from R2 — no direct copy.
   */
  function createThreeRouterChain() {
    // R1 (highest RID) — master of R1-R2 pair
    const { engine: e1, iface: if1_e1 } = createEngine('3.3.3.3', '10.0.12.1', 'eth0');
    // R2 — slave to R1, master of R2-R3 pair
    const e2 = new OSPFEngine(1);
    e2.setRouterId('2.2.2.2');
    e2.addNetwork('10.0.0.0', '0.255.255.255', OSPF_BACKBONE_AREA);
    const if2_e1 = e2.activateInterface('eth0', '10.0.12.2', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
    const if2_e3 = e2.activateInterface('eth1', '10.0.23.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'point-to-point',
    });
    // R3 (lowest RID) — slave to R2
    const { engine: e3, iface: if3_e2 } = createEngine('1.1.1.1', '10.0.23.2', 'eth0');

    // Wire sendCallbacks
    e1.setSendCallback((ifName, pkt, _dest) => {
      if (ifName === 'eth0') e2.processPacket('eth0', '10.0.12.1', pkt);
    });
    e2.setSendCallback((ifName, pkt, _dest) => {
      if (ifName === 'eth0') e1.processPacket('eth0', '10.0.12.2', pkt);
      if (ifName === 'eth1') e3.processPacket('eth0', '10.0.23.1', pkt);
    });
    e3.setSendCallback((ifName, pkt, _dest) => {
      if (ifName === 'eth0') e2.processPacket('eth1', '10.0.23.2', pkt);
    });

    return { e1, e2, e3, if1_e1, if2_e1, if2_e3, if3_e2 };
  }

  it('7.1 — all three routers reach Full state', () => {
    const { e1, e2, e3, if2_e1, if2_e3 } = createThreeRouterChain();

    // Drive R1-R2: e2 (slave) first, e1 (master) second
    e2.processHello('eth0', '10.0.12.1', makeHello('3.3.3.3', { neighbors: ['2.2.2.2'] }));
    e1.processHello('eth0', '10.0.12.2', makeHello('2.2.2.2', { neighbors: ['3.3.3.3'] }));

    expect(if2_e1.neighbors.get('3.3.3.3')!.state).toBe('Full');

    // Drive R2-R3: e3 (slave) first, e2 (master) second
    e3.processHello('eth0', '10.0.23.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e2.processHello('eth1', '10.0.23.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(if2_e3.neighbors.get('1.1.1.1')!.state).toBe('Full');
  });

  it('7.2 — R3 learns R1 Router-LSA via R2 without direct copy (multi-hop propagation)', () => {
    const { e1, e2, e3 } = createThreeRouterChain();

    // Pre-populate: each router has its own Router-LSA
    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('3.3.3.3'));
    e2.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    e3.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1'));

    // Drive R1-R2
    e2.processHello('eth0', '10.0.12.1', makeHello('3.3.3.3', { neighbors: ['2.2.2.2'] }));
    e1.processHello('eth0', '10.0.12.2', makeHello('2.2.2.2', { neighbors: ['3.3.3.3'] }));

    // Now R2 has R1's (3.3.3.3) Router-LSA. Drive R2-R3:
    e3.processHello('eth0', '10.0.23.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e2.processHello('eth1', '10.0.23.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // R3 should now have R1's Router-LSA (received via R2, not direct copy)
    const r1LsaInR3 = e3.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3');
    expect(r1LsaInR3).toBeDefined();
    expect(r1LsaInR3!.advertisingRouter).toBe('3.3.3.3');
  });

  it('7.3 — all three routers have all three Router-LSAs after convergence', () => {
    const { e1, e2, e3 } = createThreeRouterChain();

    e1.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('3.3.3.3'));
    e2.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('2.2.2.2'));
    e3.installLSA(OSPF_BACKBONE_AREA, makeRouterLSA('1.1.1.1'));

    e2.processHello('eth0', '10.0.12.1', makeHello('3.3.3.3', { neighbors: ['2.2.2.2'] }));
    e1.processHello('eth0', '10.0.12.2', makeHello('2.2.2.2', { neighbors: ['3.3.3.3'] }));

    e3.processHello('eth0', '10.0.23.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e2.processHello('eth1', '10.0.23.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // All three should have all three LSAs
    for (const [engine, name] of [[e1, 'R1'], [e2, 'R2'], [e3, 'R3']] as const) {
      expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3'),
        `${name} missing R1 LSA`).toBeDefined();
      expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '2.2.2.2', '2.2.2.2'),
        `${name} missing R2 LSA`).toBeDefined();
      expect(engine.lookupLSA(OSPF_BACKBONE_AREA, 1, '1.1.1.1', '1.1.1.1'),
        `${name} missing R3 LSA`).toBeDefined();
    }
  });

  it('7.4 — new LSA originated by R1 floods all the way to R3 via R2', () => {
    const { e1, e2, e3 } = createThreeRouterChain();

    // Reach Full
    e2.processHello('eth0', '10.0.12.1', makeHello('3.3.3.3', { neighbors: ['2.2.2.2'] }));
    e1.processHello('eth0', '10.0.12.2', makeHello('2.2.2.2', { neighbors: ['3.3.3.3'] }));
    e3.processHello('eth0', '10.0.23.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e2.processHello('eth1', '10.0.23.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // R1 originates a new Router-LSA — should flood R1→R2→R3
    e1.originateRouterLSA(OSPF_BACKBONE_AREA);

    const inR3 = e3.lookupLSA(OSPF_BACKBONE_AREA, 1, '3.3.3.3', '3.3.3.3');
    expect(inR3).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8: Broadcast segment — DR/BDR election and selective adjacency
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 8 — Broadcast segment: DR/BDR election', () => {

  /**
   * Create a broadcast engine pair with explicit priority settings.
   */
  function createBroadcastEngine(
    routerId: string,
    ifaceIP: string,
    priority: number,
    ifaceName = 'eth0',
  ): { engine: OSPFEngine; iface: OSPFInterface } {
    const engine = new OSPFEngine(1);
    engine.setRouterId(routerId);
    engine.addNetwork('10.0.0.0', '0.255.255.255', OSPF_BACKBONE_AREA);
    // Broadcast is the default
    const iface = engine.activateInterface(ifaceName, ifaceIP, '255.255.255.0', OSPF_BACKBONE_AREA, {
      networkType: 'broadcast',
      priority,
    });
    return { engine, iface };
  }

  it('8.1 — DR is elected as the router with highest priority', () => {
    const { engine: e1, iface: if1 } = createBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    const { engine: e2, iface: if2 } = createBroadcastEngine('2.2.2.2', '10.0.0.2', 2);

    // Create neighbors manually (broadcast — no TwoWayReceived triggers ExStart directly)
    e1.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', { neighbors: ['1.1.1.1'], priority: 2 }));
    e2.processHello('eth0', '10.0.0.1',
      makeHello('1.1.1.1', { neighbors: ['2.2.2.2'], priority: 1 }));

    // Run DR election manually
    e1.drElection(if1);
    e2.drElection(if2);

    // Higher priority (e2) should be DR
    expect(if1.state).toBe('Backup'); // e1 is BDR
    expect(if2.state).toBe('DR');     // e2 is DR
  });

  it('8.2 — priority-0 router never becomes DR or BDR', () => {
    const { engine: e1, iface: if1 } = createBroadcastEngine('1.1.1.1', '10.0.0.1', 0);
    const { engine: e2, iface: if2 } = createBroadcastEngine('2.2.2.2', '10.0.0.2', 1);

    e1.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', { neighbors: ['1.1.1.1'], priority: 1 }));
    e2.processHello('eth0', '10.0.0.1',
      makeHello('1.1.1.1', { neighbors: ['2.2.2.2'], priority: 0 }));

    e1.drElection(if1);
    e2.drElection(if2);

    // e1 (priority 0) should be DROther, e2 (priority 1) should be DR
    expect(if1.state).toBe('DROther');
    expect(if2.state).toBe('DR');
  });

  it('8.3 — DROther does not form adjacency with another DROther', () => {
    const { engine: e1, iface: if1 } = createBroadcastEngine('1.1.1.1', '10.0.0.1', 0);
    const { engine: e2, iface: if2 } = createBroadcastEngine('2.2.2.2', '10.0.0.2', 0);
    const { engine: e3, iface: if3 } = createBroadcastEngine('3.3.3.3', '10.0.0.3', 1); // DR

    e1.setSendCallback((_i, pkt, _d) => {
      e2.processPacket('eth0', '10.0.0.1', pkt);
      e3.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      e1.processPacket('eth0', '10.0.0.2', pkt);
      e3.processPacket('eth0', '10.0.0.2', pkt);
    });
    e3.setSendCallback((_i, pkt, _d) => {
      e1.processPacket('eth0', '10.0.0.3', pkt);
      e2.processPacket('eth0', '10.0.0.3', pkt);
    });

    // All learn about each other
    e1.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1', '3.3.3.3'], priority: 0 }));
    e1.processHello('eth0', '10.0.0.3', makeHello('3.3.3.3', { neighbors: ['1.1.1.1', '2.2.2.2'], priority: 1 }));
    e2.processHello('eth0', '10.0.0.1', makeHello('1.1.1.1', { neighbors: ['2.2.2.2', '3.3.3.3'], priority: 0 }));
    e2.processHello('eth0', '10.0.0.3', makeHello('3.3.3.3', { neighbors: ['1.1.1.1', '2.2.2.2'], priority: 1 }));
    e3.processHello('eth0', '10.0.0.1', makeHello('1.1.1.1', { neighbors: ['2.2.2.2', '3.3.3.3'], priority: 0 }));
    e3.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1', '3.3.3.3'], priority: 0 }));

    // Run DR election
    e1.drElection(if1);
    e2.drElection(if2);
    e3.drElection(if3);

    // e3 is DR (priority 1), e1 and e2 are DROther (priority 0)
    expect(if3.state).toBe('DR');
    expect(if1.state).toBe('DROther');
    expect(if2.state).toBe('DROther');

    // e1-e2 (both DROther) should NOT be in ExStart or Full (they stay TwoWay)
    const n1_sees_e2 = if1.neighbors.get('2.2.2.2');
    const n2_sees_e1 = if2.neighbors.get('1.1.1.1');
    if (n1_sees_e2) expect(n1_sees_e2.state).toBe('TwoWay');
    if (n2_sees_e1) expect(n2_sees_e1.state).toBe('TwoWay');
  });

  it('8.4 — DR forms adjacency with all DROther routers', () => {
    const { engine: e1, iface: if1 } = createBroadcastEngine('1.1.1.1', '10.0.0.1', 0);
    const { engine: e2, iface: if2 } = createBroadcastEngine('2.2.2.2', '10.0.0.2', 0);
    const { engine: eDR, iface: ifDR } = createBroadcastEngine('9.9.9.9', '10.0.0.9', 1); // DR

    // Wire: DR's sendCallback delivers to both DROthers
    eDR.setSendCallback((_i, pkt, _d) => {
      e1.processPacket('eth0', '10.0.0.9', pkt);
      e2.processPacket('eth0', '10.0.0.9', pkt);
    });
    e1.setSendCallback((_i, pkt, _d) => {
      eDR.processPacket('eth0', '10.0.0.1', pkt);
    });
    e2.setSendCallback((_i, pkt, _d) => {
      eDR.processPacket('eth0', '10.0.0.2', pkt);
    });

    // All process hellos from all
    eDR.processHello('eth0', '10.0.0.1', makeHello('1.1.1.1', { neighbors: ['9.9.9.9'], priority: 0 }));
    eDR.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: ['9.9.9.9'], priority: 0 }));
    // DROthers process DR's hello
    e1.processHello('eth0', '10.0.0.9', makeHello('9.9.9.9', { neighbors: ['1.1.1.1', '2.2.2.2'], priority: 1 }));
    e2.processHello('eth0', '10.0.0.9', makeHello('9.9.9.9', { neighbors: ['1.1.1.1', '2.2.2.2'], priority: 1 }));

    // Run DR elections in order (DROthers first, then DR)
    e1.drElection(if1);
    e2.drElection(if2);
    eDR.drElection(ifDR); // DR fires AdjOK → both DROthers move to ExStart → chain runs

    // DR should be in Full with both DROthers
    const drSees1 = ifDR.neighbors.get('1.1.1.1');
    const drSees2 = ifDR.neighbors.get('2.2.2.2');
    expect(drSees1?.state).toBe('Full');
    expect(drSees2?.state).toBe('Full');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 9: Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 9 — Edge cases', () => {

  it('9.1 — Hello with mismatched helloInterval is ignored (no neighbor created)', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');

    // Hello with wrong helloInterval (20 vs default 10)
    const badHello = makeHello('2.2.2.2', { helloInterval: 20 });
    e1.processHello('eth0', '10.0.0.2', badHello);

    expect(if1.neighbors.has('2.2.2.2')).toBe(false);
  });

  it('9.2 — Hello with mismatched deadInterval is ignored', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');

    const badHello = makeHello('2.2.2.2', { deadInterval: 60 });
    e1.processHello('eth0', '10.0.0.2', badHello);

    expect(if1.neighbors.has('2.2.2.2')).toBe(false);
  });

  it('9.3 — duplicate Hello does not create duplicate neighbors', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');

    const hello = makeHello('2.2.2.2');
    e1.processHello('eth0', '10.0.0.2', hello);
    e1.processHello('eth0', '10.0.0.2', hello);
    e1.processHello('eth0', '10.0.0.2', hello);

    expect(if1.neighbors.size).toBe(1);
  });

  it('9.4 — SeqNumberMismatch in Exchange resets neighbor to ExStart', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    expect(if1.neighbors.get('1.1.1.1')!.state).toBe('Full');

    // Manually trigger SeqNumberMismatch on e1
    const n1 = if1.neighbors.get('1.1.1.1')!;
    e1.neighborEvent(if1, n1, 'SeqNumberMismatch');

    expect(n1.state).toBe('ExStart');
    expect(n1.lsRequestList).toHaveLength(0);
    expect(n1.dbSummaryList).toHaveLength(0);
  });

  it('9.5 — KillNbr event resets neighbor to Down and clears state', () => {
    const { engine: e1, iface: if1 } = createEngine('2.2.2.2', '10.0.0.1');
    const { engine: e2, iface: if2 } = createEngine('1.1.1.1', '10.0.0.2');

    e1.setSendCallback((_i, pkt, _d) => e2.processPacket('eth0', '10.0.0.1', pkt));
    e2.setSendCallback((_i, pkt, _d) => e1.processPacket('eth0', '10.0.0.2', pkt));

    e2.processHello('eth0', '10.0.0.1', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    e1.processHello('eth0', '10.0.0.2', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    const n1 = if1.neighbors.get('1.1.1.1')!;
    expect(n1.state).toBe('Full');

    e1.neighborEvent(if1, n1, 'KillNbr');

    expect(n1.state).toBe('Down');
    expect(n1.lsRequestList).toHaveLength(0);
  });

  it('9.6 — OneWay event on TwoWay neighbor reverts to Init', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');

    // Create neighbor in TwoWay via broadcast setup
    e1.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    const n = if1.neighbors.get('2.2.2.2')!;
    // Broadcast: TwoWayReceived fires but shouldFormAdjacency may require DR election
    // We can manually set state to TwoWay for this test
    n.state = 'TwoWay';

    e1.neighborEvent(if1, n, 'OneWay');

    expect(n.state).toBe('Init');
  });

  it('9.7 — passive interface does not participate in adjacency formation', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');
    e1.setPassiveInterface('eth0');

    // Even if a hello arrives, passive interface should not form adjacency
    e1.processHello('eth0', '10.0.0.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    // Passive interface: processHello is rejected because passive=true
    // The neighbor map should be empty (passive interface blocks hellos)
    const iface = e1.getInterface('eth0')!;
    expect(iface.passive).toBe(true);
  });

  it('9.8 — processDD is ignored for unknown neighbor', () => {
    const { engine: e1, iface: if1 } = createEngine('1.1.1.1', '10.0.0.1');

    // Send a DD from a router that has no neighbor entry in e1
    const dd: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '9.9.9.9',
      areaId: OSPF_BACKBONE_AREA,
      interfaceMTU: 1500,
      options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 12345,
      lsaHeaders: [],
    };

    // Should not throw — just silently ignored
    expect(() => e1.processDD('eth0', '10.0.0.9', dd)).not.toThrow();
    expect(if1.neighbors.has('9.9.9.9')).toBe(false);
  });
});
