/**
 * OSPF Virtual Link TDD Test Suite
 *
 * Tests for OSPF Virtual Link (RFC 2328 §15):
 *   1. addVirtualLink() configuration + transit area stub validation
 *   2. VL Hello exchange — backbone areaId on transit interface, VL neighbor formed
 *   3. Router-LSA type 4 link + V-bit when VL Full
 *   4. SPF processes type 4 links (VL-connected networks reachable)
 *   5. VL Hello sent through transit area via sendCallback
 *
 * All tests are pure unit tests against OSPFEngine with no CiscoRouter CLI.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OSPF_BACKBONE_AREA,
  OSPF_INITIAL_SEQUENCE_NUMBER,
  OSPF_VERSION_2,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  type RouterLSA,
  type OSPFHelloPacket,
  type OSPFDDPacket,
  type OSPFPacket,
  makeLSDBKey,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEngine(routerId: string): OSPFEngine {
  const e = new OSPFEngine(1);
  e.setRouterId(routerId);
  e.setThrottleSPF(0, 0, 0);
  return e;
}

/** Build a VL Hello packet (areaId = '0.0.0.0', networkMask = '0.0.0.0') */
function makeVLHello(
  senderRid: string,
  neighbors: string[] = [],
): OSPFHelloPacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_2,
    packetType: 1,
    routerId: senderRid,
    areaId: OSPF_BACKBONE_AREA,      // VL packets carry backbone area ID
    networkMask: '0.0.0.0',           // RFC 2328 §A.3.2: VL hellos have mask 0.0.0.0
    helloInterval: 10,
    options: 0x02,
    priority: 0,
    deadInterval: 40,
    designatedRouter: '0.0.0.0',
    backupDesignatedRouter: '0.0.0.0',
    neighbors,
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

/**
 * Setup a basic engine with:
 * - backbone interface Gi0/0 (10.0.01.1/24)
 * - transit area 0.0.0.1 interface Gi0/1 (10.0.12.1/24)
 */
function setupEngineWithTransitArea(routerId: string): OSPFEngine {
  const engine = makeEngine(routerId);
  engine.addNetwork('10.0.1.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  engine.addNetwork('10.0.12.0', '0.0.0.255', '0.0.0.1');
  engine.activateInterface('Gi0/0', '10.0.1.1', '255.255.255.0', OSPF_BACKBONE_AREA, {
    networkType: 'point-to-point',
  });
  engine.activateInterface('Gi0/1', '10.0.12.1', '255.255.255.0', '0.0.0.1', {
    networkType: 'point-to-point',
  });
  return engine;
}

// ─── Group 1: addVirtualLink() validation ────────────────────────────────────

describe('Group 1: addVirtualLink() configuration and stub area validation', () => {
  it('1.1: accepts a normal transit area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setAreaType('0.0.0.1', 'normal');
    expect(() => engine.addVirtualLink('0.0.0.1', '2.2.2.2')).not.toThrow();
    expect(engine.getVirtualLinks().has('2.2.2.2')).toBe(true);
  });

  it('1.2: rejects a stub transit area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setAreaType('0.0.0.1', 'stub');
    expect(() => engine.addVirtualLink('0.0.0.1', '2.2.2.2')).toThrow(/stub/i);
    expect(engine.getVirtualLinks().has('2.2.2.2')).toBe(false);
  });

  it('1.3: rejects a totally-stubby transit area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setAreaType('0.0.0.1', 'totally-stubby');
    expect(() => engine.addVirtualLink('0.0.0.1', '2.2.2.2')).toThrow(/stub/i);
  });

  it('1.4: rejects an NSSA transit area', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setAreaType('0.0.0.1', 'nssa');
    expect(() => engine.addVirtualLink('0.0.0.1', '2.2.2.2')).toThrow(/nssa/i);
  });

  it('1.5: rejects when transit area is not configured', () => {
    const engine = makeEngine('1.1.1.1');
    // area '9.9.9.9' never configured
    expect(() => engine.addVirtualLink('9.9.9.9', '2.2.2.2')).toThrow();
  });

  it('1.6: VL iface is backbone (areaId=0.0.0.0) and point-to-point', () => {
    const engine = makeEngine('1.1.1.1');
    engine.setAreaType('0.0.0.1', 'normal');
    engine.addVirtualLink('0.0.0.1', '2.2.2.2');
    const vl = engine.getVirtualLinks().get('2.2.2.2')!;
    expect(vl.iface.areaId).toBe(OSPF_BACKBONE_AREA);
    expect(vl.iface.networkType).toBe('point-to-point');
  });
});

// ─── Group 2: VL Hello exchange ──────────────────────────────────────────────

describe('Group 2: VL Hello exchange', () => {
  let engine: OSPFEngine;
  const sent: Array<{ iface: string; packet: OSPFPacket; dest: string }> = [];

  beforeEach(() => {
    sent.length = 0;
    engine = setupEngineWithTransitArea('1.1.1.1');
    engine.setSendCallback((iface, packet, dest) => sent.push({ iface, packet, dest }));
    engine.addVirtualLink('0.0.0.1', '2.2.2.2');
  });

  it('2.1: backbone Hello on transit interface creates VL neighbor in Init', () => {
    // Peer '2.2.2.2' sends VL Hello (areaId=0.0.0.0) through transit area
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));
    const vl = engine.getVirtualLinks().get('2.2.2.2')!;
    const neighbor = vl.iface.neighbors.get('2.2.2.2');
    expect(neighbor).toBeDefined();
    expect(neighbor!.state).toBe('Init');
  });

  it('2.2: VL neighbor reaches TwoWay→ExStart when peer lists our Router ID', () => {
    // Step 1: Init
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));
    // Step 2: 2-Way (our RID '1.1.1.1' appears in neighbors list)
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2', ['1.1.1.1']));
    const vl = engine.getVirtualLinks().get('2.2.2.2')!;
    const neighbor = vl.iface.neighbors.get('2.2.2.2')!;
    // P2P → shouldFormAdjacency = true → goes directly to ExStart
    expect(neighbor.state).toBe('ExStart');
  });

  it('2.3: backbone Hello does NOT create neighbor when sender is not a configured VL peer', () => {
    // '9.9.9.9' is not a configured VL peer
    engine.processHello('Gi0/1', '10.0.12.9', makeVLHello('9.9.9.9'));
    // The transit interface (Gi0/1) should not have this neighbor
    const iface = engine.getInterface('Gi0/1')!;
    expect(iface.neighbors.has('9.9.9.9')).toBe(false);
    // And no VL for this peer
    expect(engine.getVirtualLinks().has('9.9.9.9')).toBe(false);
  });

  it('2.4: VL neighbor reaches Full after complete DD exchange', () => {
    vi.useFakeTimers();

    // Step 1+2: Hello exchange → ExStart
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2', ['1.1.1.1']));

    const vl = engine.getVirtualLinks().get('2.2.2.2')!;
    const neighbor = vl.iface.neighbors.get('2.2.2.2')!;
    expect(neighbor.state).toBe('ExStart');

    // Step 3: Peer sends DD(I|M|MS) → NegotiationDone → Exchange
    // (Peer '2.2.2.2' > our '1.1.1.1', so peer is Master)
    const peerDD1: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: OSPF_BACKBONE_AREA,
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 12345,
      lsaHeaders: [],
    };
    engine.processDD('Gi0/1', '10.0.12.2', peerDD1);
    expect(neighbor.state).toBe('Exchange');

    // Step 4: Peer sends DD(!I, !M, !MS) → ExchangeDone → Full (no LSAs to request)
    const peerDD2: OSPFDDPacket = {
      ...peerDD1,
      flags: 0,
      ddSequenceNumber: 12346,
      lsaHeaders: [],
    };
    engine.processDD('Gi0/1', '10.0.12.2', peerDD2);
    expect(neighbor.state).toBe('Full');

    vi.useRealTimers();
  });
});

// ─── Group 3: Router-LSA type 4 link + V-bit ─────────────────────────────────

describe('Group 3: Router-LSA type 4 link + V-bit when VL Full', () => {
  let engine: OSPFEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = setupEngineWithTransitArea('1.1.1.1');
    engine.setSendCallback(() => {});
    engine.addVirtualLink('0.0.0.1', '2.2.2.2');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive VL neighbor to Full state */
  function driveVLToFull(): void {
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2', ['1.1.1.1']));
    const peerDD1: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: OSPF_BACKBONE_AREA,
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 99999,
      lsaHeaders: [],
    };
    engine.processDD('Gi0/1', '10.0.12.2', peerDD1);
    const peerDD2: OSPFDDPacket = { ...peerDD1, flags: 0, ddSequenceNumber: 100000 };
    engine.processDD('Gi0/1', '10.0.12.2', peerDD2);
  }

  it('3.1: backbone Router-LSA has type 4 link when VL is Full', () => {
    driveVLToFull();
    const vl = engine.getVirtualLinks().get('2.2.2.2')!;
    expect(vl.iface.neighbors.get('2.2.2.2')?.state).toBe('Full');

    // Check backbone Router-LSA
    const lsdb = engine.getAreaLSDB(OSPF_BACKBONE_AREA);
    const key = makeLSDBKey(1, '1.1.1.1', '1.1.1.1');
    const lsa = lsdb?.get(key) as RouterLSA | undefined;
    expect(lsa).toBeDefined();
    const type4Link = lsa!.links.find(l => l.type === 4);
    expect(type4Link).toBeDefined();
    expect(type4Link!.linkId).toBe('2.2.2.2');
  });

  it('3.2: backbone Router-LSA has V-bit set when VL is Full', () => {
    driveVLToFull();
    const lsdb = engine.getAreaLSDB(OSPF_BACKBONE_AREA);
    const key = makeLSDBKey(1, '1.1.1.1', '1.1.1.1');
    const lsa = lsdb?.get(key) as RouterLSA | undefined;
    expect(lsa).toBeDefined();
    expect(lsa!.flags & 0x04).toBeTruthy(); // V-bit (bit 2)
  });

  it('3.3: backbone Router-LSA has no type 4 link before VL Full', () => {
    // Don't drive to Full — check before adjacency
    const lsdb = engine.getAreaLSDB(OSPF_BACKBONE_AREA);
    const key = makeLSDBKey(1, '1.1.1.1', '1.1.1.1');
    const lsa = lsdb?.get(key) as RouterLSA | undefined;
    const type4Link = lsa?.links.find(l => l.type === 4);
    expect(type4Link).toBeUndefined();
  });
});

// ─── Group 4: SPF processes type 4 links ─────────────────────────────────────

describe('Group 4: SPF processes type 4 links', () => {
  /**
   * Topology for type 4 SPF test:
   *
   *  [Engine 1.1.1.1] ---transit(area1)--- [2.2.2.2]
   *       |                                    |
   *   backbone(type4 VL)                   backbone
   *       |                                    |
   *  VL endpoint <============================VL endpoint
   *       |                                    |
   *       +--backbone---> [3.3.3.3]?    stub: 192.168.2.0/24
   *
   * Engine (1.1.1.1) has:
   *  - backbone Router-LSA with type 4 link to 2.2.2.2 (cost 10)
   *  - Peer 2.2.2.2 backbone Router-LSA has stub network 192.168.2.0/24
   * After SPF, 1.1.1.1 should reach 192.168.2.0/24 via the VL (type 4 link)
   */
  it('4.1: SPF reaches stub network via type 4 link in backbone Router-LSA', () => {
    vi.useFakeTimers();
    const engine = setupEngineWithTransitArea('1.1.1.1');
    engine.setSendCallback(() => {});
    engine.addVirtualLink('0.0.0.1', '2.2.2.2');

    // Drive VL to Full so VL neighbor IP = '10.0.12.2' is known
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2', ['1.1.1.1']));
    const dd1: OSPFDDPacket = {
      type: 'ospf', version: OSPF_VERSION_2, packetType: 2,
      routerId: '2.2.2.2', areaId: OSPF_BACKBONE_AREA,
      interfaceMTU: 1500, options: 0x02,
      flags: DD_FLAG_INIT | DD_FLAG_MORE | DD_FLAG_MASTER,
      ddSequenceNumber: 111,
      lsaHeaders: [],
    };
    engine.processDD('Gi0/1', '10.0.12.2', dd1);
    engine.processDD('Gi0/1', '10.0.12.2', { ...dd1, flags: 0, ddSequenceNumber: 112 });

    // Inject backbone LSAs:
    // Peer's backbone Router-LSA: type 4 back-link to us + stub 192.168.2.0/24
    const peerBackboneLSA = makeRouterLSA('2.2.2.2', 0x01 /* B-bit */, [
      { linkId: '1.1.1.1', linkData: '10.0.12.2', type: 4, numTOS: 0, metric: 10 },
      { linkId: '192.168.2.0', linkData: '255.255.255.0', type: 3, numTOS: 0, metric: 5 },
    ]);
    engine.installLSA(OSPF_BACKBONE_AREA, peerBackboneLSA);

    // Our backbone Router-LSA: type 4 link to peer (explicit, bypassing originateRouterLSA auto-install)
    const ourBackboneLSA = makeRouterLSA('1.1.1.1', 0x05 /* B|V bits */, [
      { linkId: '2.2.2.2', linkData: '10.0.12.1', type: 4, numTOS: 0, metric: 10 },
    ]);
    engine.installLSA(OSPF_BACKBONE_AREA, ourBackboneLSA);

    // Run SPF directly (avoids timer complexity)
    engine.runSPF();

    vi.useRealTimers();

    const routes = engine.getRoutes();
    const route192 = routes.find(r => r.network === '192.168.2.0' && r.mask === '255.255.255.0');
    expect(route192).toBeDefined();
    expect(route192!.routeType).toBe('intra-area');
    // Next hop should be the VL neighbor's transit area IP
    expect(route192!.nextHop).toBe('10.0.12.2');
  });
});

// ─── Group 5: VL Hello sent through transit area ─────────────────────────────

describe('Group 5: VL Hello sent through transit area via sendCallback', () => {
  let engine: OSPFEngine;
  const sent: Array<{ iface: string; packet: OSPFPacket; dest: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    engine = setupEngineWithTransitArea('1.1.1.1');
    engine.setSendCallback((iface, packet, dest) => sent.push({ iface, packet, dest }));
    engine.addVirtualLink('0.0.0.1', '2.2.2.2');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('5.1: VL Hello is sent with areaId = 0.0.0.0 after transit path is known', () => {
    // Inject transit area LSAs so SPF can compute path to peer
    const transitLSA = makeRouterLSA('2.2.2.2', 0, [
      { linkId: '1.1.1.1', linkData: '10.0.12.2', type: 1, numTOS: 0, metric: 10 },
      { linkId: '10.0.12.0', linkData: '255.255.255.0', type: 3, numTOS: 0, metric: 10 },
    ]);
    engine.installLSA('0.0.0.1', transitLSA);

    // Install our own transit area Router-LSA so SPF has a root
    const ourTransitLSA = makeRouterLSA('1.1.1.1', 0, [
      { linkId: '2.2.2.2', linkData: '10.0.12.1', type: 1, numTOS: 0, metric: 10 },
      { linkId: '10.0.12.0', linkData: '255.255.255.0', type: 3, numTOS: 0, metric: 10 },
    ]);
    engine.installLSA('0.0.0.1', ourTransitLSA);

    // Run SPF — populates spfTreeCache for transit area
    vi.advanceTimersByTime(1);

    // Also make peer known as VL neighbor (so sendVLHello can get their transit IP)
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));

    // Clear sent packets and trigger VL hello
    sent.length = 0;
    engine.sendVLHelloForPeer('2.2.2.2');

    // VL Hello should have been sent with areaId = '0.0.0.0'
    const vlHellos = sent.filter(s => s.packet.packetType === 1 && s.packet.areaId === OSPF_BACKBONE_AREA);
    expect(vlHellos.length).toBeGreaterThan(0);
  });

  it('5.2: VL Hello is sent through a transit area interface (not backbone)', () => {
    // Inject transit area LSAs
    const transitLSA = makeRouterLSA('2.2.2.2', 0, [
      { linkId: '1.1.1.1', linkData: '10.0.12.2', type: 1, numTOS: 0, metric: 10 },
      { linkId: '10.0.12.0', linkData: '255.255.255.0', type: 3, numTOS: 0, metric: 10 },
    ]);
    engine.installLSA('0.0.0.1', transitLSA);
    const ourTransitLSA = makeRouterLSA('1.1.1.1', 0, [
      { linkId: '2.2.2.2', linkData: '10.0.12.1', type: 1, numTOS: 0, metric: 10 },
      { linkId: '10.0.12.0', linkData: '255.255.255.0', type: 3, numTOS: 0, metric: 10 },
    ]);
    engine.installLSA('0.0.0.1', ourTransitLSA);

    vi.advanceTimersByTime(1);
    engine.processHello('Gi0/1', '10.0.12.2', makeVLHello('2.2.2.2'));

    sent.length = 0;
    engine.sendVLHelloForPeer('2.2.2.2');

    const vlHellos = sent.filter(s => s.packet.packetType === 1 && s.packet.areaId === OSPF_BACKBONE_AREA);
    expect(vlHellos.length).toBeGreaterThan(0);

    // The hello must be sent through the transit area interface (Gi0/1), not backbone (Gi0/0)
    const vlHello = vlHellos[0];
    expect(vlHello.iface).toBe('Gi0/1');
  });
});
