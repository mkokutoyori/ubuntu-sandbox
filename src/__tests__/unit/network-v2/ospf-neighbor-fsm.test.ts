/**
 * OSPF Neighbor State Machine — TDD Tests (RFC 2328 §10.3)
 *
 * Tests the full neighbor state machine:
 *   Group 1: State transitions Down → Init → 2-Way → ExStart → Exchange → Loading → Full
 *   Group 2: Master/Slave DD negotiation (§10.6-10.8)
 *   Group 3: Retransmission timers for DD and LSR packets
 *   Group 4: NBMA Attempt state
 *   Group 5: Router integration — _ospfAutoConverge uses real state machine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OSPF_VERSION_2,
  OSPF_DEFAULT_HELLO_INTERVAL, OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  makeLSDBKey,
  type OSPFHelloPacket, type OSPFDDPacket,
  type OSPFNeighborState,
  type RouterLSA,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
import { Router } from '@/network/devices/Router';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

// ─── Helpers ─────────────────────────────────────────────────────

function createEngine(routerId: string = '1.1.1.1', processId: number = 1): OSPFEngine {
  const engine = new OSPFEngine(processId);
  engine.setRouterId(routerId);
  return engine;
}

function makeHello(
  routerId: string,
  opts: Partial<OSPFHelloPacket> = {},
): OSPFHelloPacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_2,
    packetType: 1,
    routerId,
    areaId: opts.areaId ?? '0.0.0.0',
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

function getNeighborState(engine: OSPFEngine, ifaceName: string, neighborRid: string): OSPFNeighborState | undefined {
  const iface = engine.getInterface(ifaceName);
  if (!iface) return undefined;
  const neighbor = iface.neighbors.get(neighborRid);
  return neighbor?.state;
}

function getEventLog(engine: OSPFEngine): string[] {
  return engine.getEventLog();
}

// Setup a simple R1↔R2 topology with cables for integration tests
function createR1R2Topology() {
  const r1 = new Router('r1-test', 'R1');
  const r2 = new Router('r2-test', 'R2');

  // Configure IP addresses
  const r1Port = r1.getPort('GigabitEthernet0/0');
  const r2Port = r2.getPort('GigabitEthernet0/0');

  r1Port!.setIPAddress(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  r2Port!.setIPAddress(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));

  // Connect via cable
  const cable = new Cable(r1Port!, r2Port!);

  return { r1, r2, cable, r1Port, r2Port };
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: Neighbor State Transitions (RFC 2328 §10.3)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Neighbor State Transitions (RFC 2328 §10.3)', () => {
  let engine1: OSPFEngine;
  let engine2: OSPFEngine;
  const sentPackets: Array<{ iface: string; packet: any; destIP: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    engine1 = createEngine('1.1.1.1');
    engine2 = createEngine('2.2.2.2');

    sentPackets.length = 0;
    engine1.setSendCallback((iface, packet, destIP) => {
      sentPackets.push({ iface, packet, destIP });
    });

    // Activate interfaces in area 0
    engine1.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0');
    engine2.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine2.activateInterface('Gi0/0', '10.0.1.2', '255.255.255.0', '0.0.0.0');
  });

  afterEach(() => {
    engine1.shutdown();
    engine2.shutdown();
    vi.useRealTimers();
  });

  it('FSM-01: should transition from Down to Init on HelloReceived', () => {
    // Receive a Hello from R2 that does NOT list us (one-way)
    const hello = makeHello('2.2.2.2', { neighbors: [] });
    engine1.processHello('Gi0/0', '10.0.1.2', hello);

    const state = getNeighborState(engine1, 'Gi0/0', '2.2.2.2');
    expect(state).toBe('Init');

    const log = getEventLog(engine1);
    expect(log.some(e => e.includes('Down -> Init'))).toBe(true);
  });

  it('FSM-02: should transition from Init to TwoWay on TwoWayReceived (non-DR/BDR)', () => {
    // First, get to Init state
    const hello1 = makeHello('2.2.2.2', { neighbors: [] });
    engine1.processHello('Gi0/0', '10.0.1.2', hello1);
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Init');

    // Now receive Hello that lists us — TwoWayReceived
    // On broadcast, if we are not DR/BDR and neighbor is not DR/BDR, stay in TwoWay
    // Force DROther state by setting priority to 0
    const iface = engine1.getInterface('Gi0/0');
    if (iface) {
      iface.priority = 0; // Can't become DR/BDR
      iface.state = 'DROther';
    }

    const hello2 = makeHello('2.2.2.2', {
      neighbors: ['1.1.1.1'],
      priority: 0, // R2 also can't become DR/BDR
    });
    engine1.processHello('Gi0/0', '10.0.1.2', hello2);

    const state = getNeighborState(engine1, 'Gi0/0', '2.2.2.2');
    expect(state).toBe('TwoWay');

    const log = getEventLog(engine1);
    expect(log.some(e => e.includes('Init -> TwoWay'))).toBe(true);
  });

  it('FSM-03: should transition from Init directly to ExStart on TwoWayReceived (point-to-point)', () => {
    // Reset with point-to-point network
    engine1.shutdown();
    engine1 = createEngine('1.1.1.1');
    sentPackets.length = 0;
    engine1.setSendCallback((iface, packet, destIP) => {
      sentPackets.push({ iface, packet, destIP });
    });
    engine1.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Hello → Init
    const hello1 = makeHello('2.2.2.2', { neighbors: [] });
    engine1.processHello('Gi0/0', '10.0.1.2', hello1);
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Init');

    // Two-way Hello → ExStart (on p2p, always form adjacency)
    const hello2 = makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] });
    engine1.processHello('Gi0/0', '10.0.1.2', hello2);

    const state = getNeighborState(engine1, 'Gi0/0', '2.2.2.2');
    expect(state).toBe('ExStart');

    const log = getEventLog(engine1);
    expect(log.some(e => e.includes('Init -> ExStart'))).toBe(true);
  });

  it('FSM-04: should send DD packet with Init/More/Master flags in ExStart', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Go to Init then ExStart
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    sentPackets.length = 0;
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    // Should have sent a DD packet
    const ddPackets = sentPackets.filter(p => p.packet.packetType === 2);
    expect(ddPackets.length).toBeGreaterThanOrEqual(1);

    const dd = ddPackets[0].packet as OSPFDDPacket;
    expect(dd.flags & DD_FLAG_INIT).toBeTruthy();
    expect(dd.flags & DD_FLAG_MORE).toBeTruthy();
  });

  it('FSM-05: should transition ExStart → Exchange on NegotiationDone', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Down → Init → ExStart
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('ExStart');

    // Simulate DD negotiation done - R2 is master (higher RID)
    const iface = engine1.getInterface('Gi0/0');
    const neighbor = iface?.neighbors.get('2.2.2.2');
    const ddSeq = neighbor?.ddSeqNumber ?? 1;

    const ddFromR2: OSPFDDPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 2,
      routerId: '2.2.2.2',
      areaId: '0.0.0.0',
      interfaceMTU: 1500,
      options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100,
      lsaHeaders: [],
    };

    engine1.processDD('Gi0/0', '10.0.1.2', ddFromR2);

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Exchange');
    expect(getEventLog(engine1).some(e => e.includes('ExStart -> Exchange'))).toBe(true);
  });

  it('FSM-06: should transition Exchange → Loading when LS Request list is not empty', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Fast-track to Exchange
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Exchange');

    // Send DD with LSA headers that R1 doesn't have → creates LS Request entries
    const ddWithLSAs: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0, // No More flag → exchange done
      ddSequenceNumber: 101,
      lsaHeaders: [{
        lsAge: 0, options: 0x02, lsType: 1,
        linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
        lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
        checksum: 0, length: 48,
      }],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddWithLSAs);

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Loading');
    expect(getEventLog(engine1).some(e => e.includes('Exchange -> Loading'))).toBe(true);
  });

  it('FSM-07: should transition Exchange → Full when LS Request list is empty', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Fast-track to Exchange
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);

    // DD with no LSA headers and no More flag → empty request list → straight to Full
    const ddEmpty: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0, // No More
      ddSequenceNumber: 101, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddEmpty);

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Full');
    expect(getEventLog(engine1).some(e => e.includes('-> Full'))).toBe(true);
  });

  it('FSM-08: should transition Loading → Full on LoadingDone', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Fast-track to Loading
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);

    // DD with an unknown LSA → goes to Loading
    const ddWithLSA: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0,
      ddSequenceNumber: 101,
      lsaHeaders: [{
        lsAge: 0, options: 0x02, lsType: 1,
        linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
        lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
        checksum: 0, length: 48,
      }],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddWithLSA);
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Loading');

    // Now send LS Update with the requested LSA
    const routerLSA: RouterLSA = {
      lsAge: 0, options: 0x02, lsType: 1,
      linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
      lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
      checksum: 0, length: 48,
      flags: 0, numLinks: 0, links: [],
    };

    engine1.processLSUpdate('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 4,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      numLSAs: 1, lsas: [routerLSA],
    });

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Full');
    expect(getEventLog(engine1).some(e => e.includes('Loading -> Full'))).toBe(true);
  });

  it('FSM-09: should record full state sequence in event log', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Complete the full transition Down→Init→ExStart→Exchange→Full
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);

    const ddEnd: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0, ddSequenceNumber: 101, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddEnd);

    const log = getEventLog(engine1);
    const transitions = log.filter(e => e.includes('Neighbor 2.2.2.2'));

    expect(transitions.some(e => e.includes('Down -> Init'))).toBe(true);
    expect(transitions.some(e => e.includes('Init -> ExStart'))).toBe(true);
    expect(transitions.some(e => e.includes('ExStart -> Exchange'))).toBe(true);
    expect(transitions.some(e => e.includes('Exchange -> Full') || e.includes('-> Full'))).toBe(true);
  });

  it('FSM-10: should go back to ExStart on SeqNumberMismatch from Exchange state', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Get to Exchange
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Exchange');

    // Trigger SeqNumberMismatch
    const iface = engine1.getInterface('Gi0/0')!;
    const neighbor = iface.neighbors.get('2.2.2.2')!;
    engine1.neighborEvent(iface, neighbor, 'SeqNumberMismatch');

    expect(neighbor.state).toBe('ExStart');
    expect(neighbor.lsRequestList).toEqual([]);
    expect(neighbor.dbSummaryList).toEqual([]);
  });

  it('FSM-11: should go to Init on OneWay event from Full state', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Get to Full
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    const ddNeg: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', ddNeg);
    engine1.processDD('Gi0/0', '10.0.1.2', {
      ...ddNeg, flags: 0, ddSequenceNumber: 101, lsaHeaders: [],
    });
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Full');

    // OneWay: neighbor stops listing us
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Init');
  });

  it('FSM-12: should go to Down on InactivityTimer (dead timer expiry)', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Get to Init
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Init');

    // Advance time past dead interval (40 seconds)
    vi.advanceTimersByTime(41 * 1000);

    // Neighbor should be removed (Down state → removed from map)
    const iface = engine1.getInterface('Gi0/0');
    expect(iface?.neighbors.has('2.2.2.2')).toBe(false);

    const log = getEventLog(engine1);
    expect(log.some(e => e.includes('InactivityTimer'))).toBe(true);
  });

  it('FSM-13: should clear lists on KillNbr event', () => {
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });

    // Get to Exchange (neighbor has request list entries)
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const iface = engine1.getInterface('Gi0/0')!;
    const neighbor = iface.neighbors.get('2.2.2.2')!;

    // Artificially add request list entries
    neighbor.lsRequestList = [{ lsAge: 0, options: 0, lsType: 1, linkStateId: '3.3.3.3', advertisingRouter: '3.3.3.3', lsSequenceNumber: 1, checksum: 0, length: 0 }];

    engine1.neighborEvent(iface, neighbor, 'KillNbr');

    expect(neighbor.state).toBe('Down');
    expect(neighbor.lsRequestList).toEqual([]);
    expect(neighbor.lsRetransmissionList).toEqual([]);
    expect(neighbor.dbSummaryList).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Master/Slave DD Negotiation (RFC 2328 §10.6-10.8)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Master/Slave DD Negotiation', () => {
  let engine1: OSPFEngine;
  let engine2: OSPFEngine;
  const sent1: Array<{ iface: string; packet: any; destIP: string }> = [];
  const sent2: Array<{ iface: string; packet: any; destIP: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    engine1 = createEngine('1.1.1.1');
    engine2 = createEngine('2.2.2.2');

    sent1.length = 0;
    sent2.length = 0;

    engine1.setSendCallback((iface, packet, destIP) => {
      sent1.push({ iface, packet, destIP });
    });
    engine2.setSendCallback((iface, packet, destIP) => {
      sent2.push({ iface, packet, destIP });
    });

    engine1.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine1.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });
    engine2.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine2.activateInterface('Gi0/0', '10.0.1.2', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });
  });

  afterEach(() => {
    engine1.shutdown();
    engine2.shutdown();
    vi.useRealTimers();
  });

  it('MS-01: router with higher Router ID should become Master', () => {
    // R1 (1.1.1.1) < R2 (2.2.2.2), so R2 should be Master
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    const iface = engine1.getInterface('Gi0/0')!;
    const neighbor = iface.neighbors.get('2.2.2.2')!;

    // R1 should recognize R2 as having higher RID
    // The isMaster flag on R1's neighbor record means "is neighbor the master?"
    // Initially in startDDExchange: isMaster = this.config.routerId > neighbor.routerId
    // 1.1.1.1 < 2.2.2.2, so isMaster should be false (R1 is slave)
    expect(neighbor.isMaster).toBe(false);
  });

  it('MS-02: Master should set MS flag in DD packets', () => {
    // R2 (higher RID) processes Hello
    engine2.processHello('Gi0/0', '10.0.1.1', makeHello('1.1.1.1', { neighbors: [] }));
    sent2.length = 0;
    engine2.processHello('Gi0/0', '10.0.1.1', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    const ddPackets = sent2.filter(p => p.packet.packetType === 2);
    expect(ddPackets.length).toBeGreaterThanOrEqual(1);

    // R2 is master (higher RID), so DD should have MS flag
    const dd = ddPackets[0].packet as OSPFDDPacket;
    expect(dd.flags & DD_FLAG_MASTER).toBeTruthy();
  });

  it('MS-03: Slave should accept Master sequence number after negotiation', () => {
    // R1 goes through Init → ExStart
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    // R2 sends DD with I|M|MS flags as master
    const masterDD: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 42,
      lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', masterDD);

    // R1 should now use R2's sequence number
    const iface = engine1.getInterface('Gi0/0')!;
    const neighbor = iface.neighbors.get('2.2.2.2')!;
    expect(neighbor.ddSeqNumber).toBe(42);
    expect(neighbor.state).toBe('Exchange');
  });

  it('MS-04: bidirectional DD exchange should complete', () => {
    // Full bidirectional DD exchange
    // R1 receives hello → Init
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine2.processHello('Gi0/0', '10.0.1.1', makeHello('1.1.1.1', { neighbors: [] }));

    // Two-way hellos → ExStart
    engine1.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    engine2.processHello('Gi0/0', '10.0.1.1', makeHello('1.1.1.1', { neighbors: ['2.2.2.2'] }));

    // Forward DD packets between them
    // R2 is master (higher RID)
    const r2DD = sent2.filter(p => p.packet.packetType === 2);
    for (const p of r2DD) {
      engine1.processDD('Gi0/0', '10.0.1.2', p.packet);
    }

    // Send empty DD to finalize
    const finalDD: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0, // No more, no init, no master
      ddSequenceNumber: 101,
      lsaHeaders: [],
    };
    engine1.processDD('Gi0/0', '10.0.1.2', finalDD);

    expect(getNeighborState(engine1, 'Gi0/0', '2.2.2.2')).toBe('Full');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 3: Retransmission Timers
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Retransmission Timers', () => {
  let engine: OSPFEngine;
  const sentPackets: Array<{ iface: string; packet: any; destIP: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    engine = createEngine('1.1.1.1');
    sentPackets.length = 0;
    engine.setSendCallback((iface, packet, destIP) => {
      sentPackets.push({ iface, packet, destIP });
    });
    engine.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    engine.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'point-to-point',
    });
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('RT-01: should retransmit DD packet after retransmitInterval', () => {
    // Get to ExStart
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    expect(getNeighborState(engine, 'Gi0/0', '2.2.2.2')).toBe('ExStart');

    const ddCountBefore = sentPackets.filter(p => p.packet.packetType === 2).length;

    // Wait for retransmit interval (default 5 seconds)
    vi.advanceTimersByTime(6000);

    const ddCountAfter = sentPackets.filter(p => p.packet.packetType === 2).length;
    expect(ddCountAfter).toBeGreaterThan(ddCountBefore);
  });

  it('RT-02: should retransmit LS Request after retransmitInterval in Loading state', () => {
    // Get to Loading state
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));

    // Negotiate DD
    engine.processDD('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    });

    // DD with unknown LSA → Loading
    engine.processDD('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0,
      ddSequenceNumber: 101,
      lsaHeaders: [{
        lsAge: 0, options: 0x02, lsType: 1,
        linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
        lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
        checksum: 0, length: 48,
      }],
    });
    expect(getNeighborState(engine, 'Gi0/0', '2.2.2.2')).toBe('Loading');

    const lsrCountBefore = sentPackets.filter(p => p.packet.packetType === 3).length;

    // Wait for retransmit interval
    vi.advanceTimersByTime(6000);

    const lsrCountAfter = sentPackets.filter(p => p.packet.packetType === 3).length;
    expect(lsrCountAfter).toBeGreaterThan(lsrCountBefore);
  });

  it('RT-03: should stop retransmission when neighbor reaches Full state', () => {
    // Get to Loading
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));
    engine.processHello('Gi0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: ['1.1.1.1'] }));
    engine.processDD('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 100, lsaHeaders: [],
    });
    engine.processDD('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      interfaceMTU: 1500, options: 0x02,
      flags: 0, ddSequenceNumber: 101,
      lsaHeaders: [{
        lsAge: 0, options: 0x02, lsType: 1,
        linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
        lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
        checksum: 0, length: 48,
      }],
    });
    expect(getNeighborState(engine, 'Gi0/0', '2.2.2.2')).toBe('Loading');

    // Receive the LSA → Full
    engine.processLSUpdate('Gi0/0', '10.0.1.2', {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 4,
      routerId: '2.2.2.2', areaId: '0.0.0.0',
      numLSAs: 1, lsas: [{
        lsAge: 0, options: 0x02, lsType: 1,
        linkStateId: '2.2.2.2', advertisingRouter: '2.2.2.2',
        lsSequenceNumber: OSPF_INITIAL_SEQUENCE_NUMBER,
        checksum: 0, length: 48,
        flags: 0, numLinks: 0, links: [],
      }],
    });
    expect(getNeighborState(engine, 'Gi0/0', '2.2.2.2')).toBe('Full');

    const lsrCountBefore = sentPackets.filter(p => p.packet.packetType === 3).length;
    vi.advanceTimersByTime(30000);
    const lsrCountAfter = sentPackets.filter(p => p.packet.packetType === 3).length;

    // No more retransmissions after Full
    expect(lsrCountAfter).toBe(lsrCountBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 4: NBMA Attempt State
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: NBMA Attempt State', () => {
  let engine: OSPFEngine;
  const sentPackets: Array<{ iface: string; packet: any; destIP: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    engine = createEngine('1.1.1.1');
    sentPackets.length = 0;
    engine.setSendCallback((iface, packet, destIP) => {
      sentPackets.push({ iface, packet, destIP });
    });
    engine.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
  });

  afterEach(() => {
    engine.shutdown();
    vi.useRealTimers();
  });

  it('NBMA-01: should support NBMA network type on interface', () => {
    const iface = engine.activateInterface('Ser0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'nbma',
    });
    expect(iface.networkType).toBe('nbma');
  });

  it('NBMA-02: should allow adding static NBMA neighbor with Attempt state', () => {
    engine.activateInterface('Ser0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'nbma',
    });

    // Add a static neighbor for NBMA
    engine.addNBMANeighbor('Ser0/0', '10.0.1.2', '2.2.2.2');

    const iface = engine.getInterface('Ser0/0');
    expect(iface?.neighbors.has('2.2.2.2')).toBe(true);

    const neighbor = iface?.neighbors.get('2.2.2.2');
    expect(neighbor?.state).toBe('Attempt');
  });

  it('NBMA-03: should send Hello to specific NBMA neighbors (not multicast)', () => {
    engine.activateInterface('Ser0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'nbma',
    });
    engine.addNBMANeighbor('Ser0/0', '10.0.1.2', '2.2.2.2');

    sentPackets.length = 0;

    // Trigger a hello send
    vi.advanceTimersByTime(11000); // Past hello interval

    // On NBMA, hellos should be sent to specific neighbor IPs, not 224.0.0.5
    const hellos = sentPackets.filter(p => p.packet.packetType === 1);
    expect(hellos.length).toBeGreaterThan(0);

    // Check that at least one hello was sent to the specific neighbor IP
    const toNeighbor = hellos.filter(p => p.destIP === '10.0.1.2');
    expect(toNeighbor.length).toBeGreaterThan(0);
  });

  it('NBMA-04: should transition Attempt → Init on HelloReceived', () => {
    engine.activateInterface('Ser0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'nbma',
    });
    engine.addNBMANeighbor('Ser0/0', '10.0.1.2', '2.2.2.2');

    expect(getNeighborState(engine, 'Ser0/0', '2.2.2.2')).toBe('Attempt');

    // Receive Hello from neighbor
    engine.processHello('Ser0/0', '10.0.1.2', makeHello('2.2.2.2', { neighbors: [] }));

    expect(getNeighborState(engine, 'Ser0/0', '2.2.2.2')).toBe('Init');
  });

  it('NBMA-05: should transition back to Down if NBMA neighbor times out from Attempt', () => {
    engine.activateInterface('Ser0/0', '10.0.1.1', '255.255.255.0', '0.0.0.0', {
      networkType: 'nbma',
    });
    engine.addNBMANeighbor('Ser0/0', '10.0.1.2', '2.2.2.2');

    expect(getNeighborState(engine, 'Ser0/0', '2.2.2.2')).toBe('Attempt');

    // Advance past dead interval without receiving any Hello
    vi.advanceTimersByTime(OSPF_DEFAULT_DEAD_INTERVAL * 1000 + 1000);

    const iface = engine.getInterface('Ser0/0');
    // After timeout, the neighbor should transition to Down or be removed
    const neighbor = iface?.neighbors.get('2.2.2.2');
    expect(!neighbor || neighbor.state === 'Down').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 5: Router Integration — Auto-convergence with real FSM
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Router Integration — Auto-convergence with FSM', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('INT-01: _ospfAutoConverge should produce neighbors that went through state transitions', () => {
    const { r1, r2, cable } = createR1R2Topology();

    // Enable OSPF on both routers
    r1._enableOSPF(1);
    r2._enableOSPF(1);

    r1._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    r2._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');

    // Trigger convergence
    r1._ospfAutoConverge();

    // After convergence, neighbors should be in Full state
    const engine1 = r1._getOSPFEngineInternal()!;
    const iface = engine1.getInterface('GigabitEthernet0/0');
    expect(iface).toBeDefined();

    // Find the neighbor
    let neighborState: OSPFNeighborState | undefined;
    for (const [, n] of iface!.neighbors) {
      neighborState = n.state;
    }
    expect(neighborState).toBe('Full');

    // Event log should show state transitions (not just jump to Full)
    const log = engine1.getEventLog();
    const hasTransitions = log.some(e => e.includes('Down -> Init') || e.includes('Init ->'));
    expect(hasTransitions).toBe(true);

    // Cleanup
    cable.disconnect();
  });

  it('INT-02: _ospfAutoConverge should still install routes correctly', () => {
    const { r1, r2, cable } = createR1R2Topology();

    // Add a second interface on R2 for a remote network
    const r2Port1 = r2.getPort('GigabitEthernet0/1');
    r2Port1!.setIPAddress(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));

    r1._enableOSPF(1);
    r2._enableOSPF(1);

    r1._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    r2._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    r2._getOSPFEngineInternal()!.addNetwork('192.168.1.0', '0.0.0.255', '0.0.0.0');

    r1._ospfAutoConverge();

    // R1 should have learned the 192.168.1.0/24 route
    const routes = (r1 as any).routingTable as Array<{ network: string; type: string }>;
    const ospfRoutes = routes.filter((r: any) => r.type === 'ospf');
    expect(ospfRoutes.some((r: any) =>
      r.network === '192.168.1.0' || r.network?.toString?.() === '192.168.1.0'
    )).toBe(true);

    cable.disconnect();
  });

  it('INT-03: event log should show full Down→Init→ExStart→Exchange→Full sequence', () => {
    const { r1, r2, cable } = createR1R2Topology();

    r1._enableOSPF(1);
    r2._enableOSPF(1);

    r1._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');
    r2._getOSPFEngineInternal()!.addNetwork('10.0.1.0', '0.0.0.255', '0.0.0.0');

    r1._ospfAutoConverge();

    const log = r1._getOSPFEngineInternal()!.getEventLog();
    const transitions = log.filter(e => e.includes('Neighbor'));

    // Should see the progression through states
    expect(transitions.some(e => e.includes('Down -> Init'))).toBe(true);
    expect(transitions.some(e => e.includes('-> ExStart') || e.includes('-> Exchange'))).toBe(true);
    expect(transitions.some(e => e.includes('-> Full'))).toBe(true);

    cable.disconnect();
  });
});
