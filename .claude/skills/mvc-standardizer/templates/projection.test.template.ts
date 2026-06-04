/**
 * TEMPLATE — Tests for a standardized feature.
 *
 * Copy to `src/__tests__/unit/network-v2/<feature>.test.ts` (or unit/gui for
 * view-logic). Replace `Lldp`/`lldp`.
 *
 * Test pyramid for the MVC mould:
 *   1. PURE PROJECTIONS  — the bulk. Domain input → expected VM. No mounting.
 *   2. ENGINE            — drive the VirtualTimeScheduler + EventBus, assert Signals.
 *   3. VIEW LOGIC        — the pure `*-logic.ts` functions (often a separate file).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { projectNeighbors, projectRuntime } from '@/network/lldp/observables';
import { LldpEngine } from '@/network/lldp/LldpEngine';

// ── 1. Pure projections — fast, deterministic, no engine ───────────────────

describe('projectNeighbors', () => {
  it('returns an empty array for no neighbors', () => {
    expect(projectNeighbors([], 0)).toEqual([]);
  });

  it('computes ageSeconds from learnedAtMs and nowMs', () => {
    const vm = projectNeighbors(
      [{ localPort: 'Gi0/0', chassisId: 'aa', remotePortId: 'Gi0/1', systemName: 'R2', ttlSeconds: 120, learnedAtMs: 1_000 }],
      6_000,
    );
    expect(vm).toHaveLength(1);
    expect(vm[0].ageSeconds).toBe(5); // (6000 - 1000) / 1000
    expect(vm[0].systemName).toBe('R2');
  });

  it('never returns a negative age (clock skew edge case)', () => {
    const vm = projectNeighbors(
      [{ localPort: 'Gi0/0', chassisId: 'aa', remotePortId: 'Gi0/1', systemName: 'R2', ttlSeconds: 120, learnedAtMs: 9_000 }],
      1_000,
    );
    expect(vm[0].ageSeconds).toBe(0);
  });
});

describe('projectRuntime', () => {
  it('mirrors counters into the VM', () => {
    expect(projectRuntime({ enabled: true, txCount: 3, rxCount: 7, neighborCount: 2 })).toEqual({
      enabled: true, txCount: 3, rxCount: 7, neighborCount: 2,
    });
  });
});

// ── 2. Engine — deterministic via VirtualTimeScheduler + isolated bus ──────

describe('LldpEngine', () => {
  let bus: EventBus;
  let scheduler: VirtualTimeScheduler;
  let engine: LldpEngine;

  beforeEach(() => {
    bus = new EventBus();
    scheduler = new VirtualTimeScheduler();
    engine = new LldpEngine('dev-1', bus, scheduler);
  });

  it('refreshes the neighbor signal after an advertisement is received', () => {
    engine.start();
    engine.onAdvertisementReceived({
      localPort: 'Gi0/0', chassisId: 'aa', remotePortId: 'Gi0/1', systemName: 'R2', ttlSeconds: 120,
    });
    const neighbors = engine.observables.neighbors.get();
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].systemName).toBe('R2');
  });

  it('advertises on the scheduled interval (virtual time)', () => {
    engine.start();
    const before = engine.observables.runtime.get().txCount;
    scheduler.advance(30_000); // fire the tx interval once, deterministically
    expect(engine.observables.runtime.get().txCount).toBe(before + 1);
  });

  it('stops emitting after stop()', () => {
    engine.start();
    engine.stop();
    const before = engine.observables.runtime.get().txCount;
    scheduler.advance(60_000);
    expect(engine.observables.runtime.get().txCount).toBe(before);
  });
});
