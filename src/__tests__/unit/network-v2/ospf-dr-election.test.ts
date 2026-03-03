/**
 * OSPF DR/BDR Election TDD Test Suite — Step 6
 *
 * Tests for three previously missing behaviours:
 *   1. Wait Timer    — election must respect the Dead Interval before running;
 *                      BackupSeen (case 1 & 2) may fire it early.
 *   2. Non-preemption — once a DR is elected, a higher-priority newcomer must
 *                       NOT unseat it (NbrChange triggers re-election but
 *                       incumbent keeps its role).
 *   3. DR departure   — when the DR goes down the BDR is promoted to DR and a
 *                       fresh BDR election is run for the remaining candidates.
 *
 * Timing tests use vi.useFakeTimers().
 * Departure / NbrChange tests call drElection() directly to avoid the
 * dead-timer-vs-wait-timer race when advancing fake time by deadInterval.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OSPF_VERSION_2,
  OSPF_BACKBONE_AREA,
  OSPF_DEFAULT_DEAD_INTERVAL,
  type OSPFHelloPacket,
  type OSPFInterface,
} from '@/network/ospf/types';
import { OSPFEngine } from '@/network/ospf/OSPFEngine';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Hello packet for a broadcast interface with deadInterval=40. */
function makeHello(
  routerId: string,
  opts: Partial<OSPFHelloPacket> = {},
): OSPFHelloPacket {
  return {
    type: 'ospf',
    version: OSPF_VERSION_2,
    packetType: 1,
    routerId,
    areaId: OSPF_BACKBONE_AREA,
    networkMask: '255.255.255.0',
    helloInterval: 10,
    options: 0x02,
    priority: opts.priority ?? 1,
    deadInterval: OSPF_DEFAULT_DEAD_INTERVAL,
    designatedRouter: opts.designatedRouter ?? '0.0.0.0',
    backupDesignatedRouter: opts.backupDesignatedRouter ?? '0.0.0.0',
    neighbors: opts.neighbors ?? [],
  };
}

/** Create a broadcast engine with a single interface. */
function makeBroadcastEngine(
  routerId: string,
  ifaceIP: string,
  priority = 1,
  ifaceName = 'eth0',
): { engine: OSPFEngine; iface: OSPFInterface } {
  const engine = new OSPFEngine(1);
  engine.setRouterId(routerId);
  engine.addNetwork('10.0.0.0', '0.0.0.255', OSPF_BACKBONE_AREA);
  const iface = engine.activateInterface(ifaceName, ifaceIP, '255.255.255.0', OSPF_BACKBONE_AREA, {
    networkType: 'broadcast',
    priority,
    deadInterval: OSPF_DEFAULT_DEAD_INTERVAL,
  });
  return { engine, iface };
}

/**
 * Set up a 3-router segment from R3's perspective WITHOUT advancing fake time.
 * R1=DR (priority 2), R2=BDR (priority 1), R3=us (priority 1, DROther).
 * We call drElection() directly so we avoid the dead-timer vs wait-timer race.
 */
function setupThreeRouterSegment(): { engine: OSPFEngine; iface: OSPFInterface } {
  const { engine, iface } = makeBroadcastEngine('3.3.3.3', '10.0.0.3', 1);

  // Feed R3 hellos from R1 (DR) and R2 (BDR) — each hello lists R3 so we go TwoWay
  engine.processHello('eth0', '10.0.0.1',
    makeHello('1.1.1.1', {
      priority: 2,
      designatedRouter: '10.0.0.1',        // R1 declares itself DR
      backupDesignatedRouter: '10.0.0.2',  // R1 declares R2 as BDR
      neighbors: ['3.3.3.3'],
    }));
  engine.processHello('eth0', '10.0.0.2',
    makeHello('2.2.2.2', {
      priority: 1,
      designatedRouter: '10.0.0.1',        // R2 acknowledges R1 as DR
      backupDesignatedRouter: '10.0.0.2',  // R2 declares itself BDR
      neighbors: ['3.3.3.3'],
    }));

  // Run election directly (skip wait timer to avoid dead-timer race)
  engine.drElection(iface);

  return { engine, iface };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Wait Timer
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 1 — Wait Timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('1.1 — interface starts in Waiting state (no election yet)', () => {
    const { iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1');
    expect(iface.state).toBe('Waiting');
    expect(iface.waitTimer).not.toBeNull();
  });

  it('1.2 — election runs after deadInterval (Wait Timer fires)', () => {
    const { iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    expect(iface.state).toBe('Waiting');

    vi.advanceTimersByTime(OSPF_DEFAULT_DEAD_INTERVAL * 1000);

    // Alone on segment → DR (BDR = '0.0.0.0', no other candidate)
    expect(iface.state).toBe('DR');
    expect(iface.waitTimer).toBeNull();
  });

  it('1.3 — BackupSeen case 1: neighbor declaring BDR=self triggers immediate election', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    expect(iface.state).toBe('Waiting');

    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 2,
        backupDesignatedRouter: '10.0.0.2',  // BDR = self
        neighbors: ['1.1.1.1'],
      }));

    // BackupSeen case 1 → wait timer cancelled, election ran
    expect(iface.state).not.toBe('Waiting');
    expect(iface.waitTimer).toBeNull();
  });

  it('1.4 — BackupSeen case 2: neighbor declaring DR=self (no BDR) triggers immediate election', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    expect(iface.state).toBe('Waiting');

    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 2,
        designatedRouter: '10.0.0.2',       // DR = self
        backupDesignatedRouter: '0.0.0.0',  // no BDR
        neighbors: ['1.1.1.1'],
      }));

    // BackupSeen case 2 → wait timer cancelled, election ran
    expect(iface.state).not.toBe('Waiting');
    expect(iface.waitTimer).toBeNull();
  });

  it('1.5 — hello without BackupSeen conditions does NOT cancel wait timer', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    expect(iface.state).toBe('Waiting');

    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 2,
        designatedRouter: '0.0.0.0',
        backupDesignatedRouter: '0.0.0.0',
        neighbors: ['1.1.1.1'],
      }));

    // Still Waiting — pure join hello, no BackupSeen
    expect(iface.state).toBe('Waiting');
    expect(iface.waitTimer).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Non-preemption (NbrChange + incumbent protection)
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 2 — Non-preemption (NbrChange)', () => {

  it('2.1 — drElection() alone on segment → becomes DR with no BDR', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    engine.drElection(iface);
    expect(iface.state).toBe('DR');
    expect(iface.dr).toBe('10.0.0.1');
    expect(iface.bdr).toBe('0.0.0.0');
  });

  it('2.2 — NbrChange: new neighbor joining triggers re-election on non-Waiting interface', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 2);
    engine.drElection(iface);   // becomes DR alone
    expect(iface.state).toBe('DR');

    // R2 (lower priority) joins — NbrChange should trigger re-election automatically
    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 1,
        designatedRouter: '0.0.0.0',
        backupDesignatedRouter: '0.0.0.0',
        neighbors: ['1.1.1.1'],
      }));

    // R1 stays DR, R2 becomes BDR
    expect(iface.state).toBe('DR');
    expect(iface.dr).toBe('10.0.0.1');
    expect(iface.bdr).toBe('10.0.0.2');
  });

  it('2.3 — Non-preemption: higher-priority newcomer does NOT unseat incumbent DR', () => {
    const { engine, iface } = makeBroadcastEngine('1.1.1.1', '10.0.0.1', 1);
    engine.drElection(iface);   // R1 (priority=1) becomes DR alone
    expect(iface.state).toBe('DR');

    // R2 (priority=5, higher) joins but initially declares dr='0.0.0.0'
    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 5,
        designatedRouter: '0.0.0.0',       // newcomer hasn't claimed DR yet
        backupDesignatedRouter: '0.0.0.0',
        neighbors: ['1.1.1.1'],
      }));

    // Incumbent R1 must stay DR — R2 is not in the drDeclaring pool
    expect(iface.state).toBe('DR');
    expect(iface.dr).toBe('10.0.0.1');
  });

  it('2.4 — NbrChange: neighbor changing its DR declaration triggers re-election', () => {
    const { engine, iface } = makeBroadcastEngine('5.5.5.5', '10.0.0.5', 2);
    engine.drElection(iface);   // R5 (priority=2) becomes DR alone
    expect(iface.state).toBe('DR');

    // R2 joins with dr='0.0.0.0'
    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 1,
        designatedRouter: '0.0.0.0',
        backupDesignatedRouter: '0.0.0.0',
        neighbors: ['5.5.5.5'],
      }));
    expect(iface.state).toBe('DR');  // R5 still DR, R2 becomes BDR

    // R2 updates hello: now acknowledges R5 as DR (NbrChange in DR field)
    engine.processHello('eth0', '10.0.0.2',
      makeHello('2.2.2.2', {
        priority: 1,
        designatedRouter: '10.0.0.5',       // now acknowledges R5 as DR
        backupDesignatedRouter: '10.0.0.2', // R2 now declares itself BDR
        neighbors: ['5.5.5.5'],
      }));

    // R5 remains DR after re-election triggered by NbrChange
    expect(iface.state).toBe('DR');
    expect(iface.dr).toBe('10.0.0.5');
    expect(iface.bdr).toBe('10.0.0.2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: DR departure → BDR promotion + new BDR election
// ─────────────────────────────────────────────────────────────────────────────

describe('Group 3 — DR departure: BDR promotion and new BDR election', () => {

  it('3.0 — setup: R3 is DROther, dr=R1, bdr=R2', () => {
    const { iface } = setupThreeRouterSegment();
    expect(iface.state).toBe('DROther');
    expect(iface.dr).toBe('10.0.0.1');
    expect(iface.bdr).toBe('10.0.0.2');
  });

  it('3.1 — when DR neighbor departs (InactivityTimer), drElection() is triggered', () => {
    const { engine, iface } = setupThreeRouterSegment();
    const drNeighbor = iface.neighbors.get('1.1.1.1');
    expect(drNeighbor).toBeDefined();

    engine.neighborEvent(iface, drNeighbor!, 'InactivityTimer');

    // State must have changed (election ran after departure)
    expect(iface.state).not.toBe('DROther');
  });

  it('3.2 — when DR departs, BDR (R2) is promoted to DR', () => {
    const { engine, iface } = setupThreeRouterSegment();
    const drNeighbor = iface.neighbors.get('1.1.1.1')!;

    engine.neighborEvent(iface, drNeighbor, 'InactivityTimer');

    expect(iface.dr).toBe('10.0.0.2');
  });

  it('3.3 — when DR departs, new BDR is elected from remaining candidates (R3=us)', () => {
    const { engine, iface } = setupThreeRouterSegment();
    const drNeighbor = iface.neighbors.get('1.1.1.1')!;

    engine.neighborEvent(iface, drNeighbor, 'InactivityTimer');

    // R2 is now DR, R3 (us) should be new BDR
    expect(iface.bdr).toBe('10.0.0.3');
    expect(iface.state).toBe('Backup');
  });

  it('3.4 — when BDR departs, DR stays and new BDR is elected', () => {
    const { engine, iface } = setupThreeRouterSegment();
    const bdrNeighbor = iface.neighbors.get('2.2.2.2')!;

    engine.neighborEvent(iface, bdrNeighbor, 'InactivityTimer');

    // R1 must still be DR; R3 (us) should become BDR
    expect(iface.dr).toBe('10.0.0.1');
    expect(iface.bdr).toBe('10.0.0.3');
    expect(iface.state).toBe('Backup');
  });

  it('3.5 — when both R1 and R2 depart, R3 (us) becomes sole DR', () => {
    const { engine, iface } = setupThreeRouterSegment();

    engine.neighborEvent(iface, iface.neighbors.get('1.1.1.1')!, 'InactivityTimer');
    engine.neighborEvent(iface, iface.neighbors.get('2.2.2.2')!, 'InactivityTimer');

    expect(iface.state).toBe('DR');
    expect(iface.dr).toBe('10.0.0.3');
  });
});
