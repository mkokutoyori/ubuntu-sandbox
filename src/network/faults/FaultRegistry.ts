/**
 * FaultRegistry — the current set of things that are wrong.
 *
 * Deliberately dumb: it aggregates, it never decides. Every fault comes in
 * through `raise()` from a projection that translates a domain event; the
 * registry only owns identity, deduplication, resolution and querying
 * (docs/PRD-Pannes.md §6.1).
 *
 * Two properties matter and are tested:
 *
 *  - **Idempotence by id.** A flapping port re-raises the same id; `since`
 *    is preserved so the UI can show how long it has really been broken,
 *    and no duplicate entry appears.
 *  - **Event-driven resolution.** A fault clears when its inverse event
 *    arrives, never on a timer. There is no sweep, no TTL — the same
 *    reasoning that keeps the rest of the simulator reactive.
 */

import { Logger } from '../core/Logger';
import { catalogEntry } from './faultCatalog';
import {
  type Fault,
  type FaultCode,
  type FaultSeverity,
  type ResolvedFault,
  SEVERITY_ORDER,
  faultId,
  loggerLevelFor,
} from './FaultTypes';

/** Input to `raise()` — the catalogue fills in the rest. */
export interface RaiseFaultInput {
  readonly code: FaultCode;
  readonly deviceId: string;
  readonly scope: string;
  readonly summary: string;
  /** Overrides the catalogue default when the consequence differs (P7). */
  readonly severity?: FaultSeverity;
  readonly causedBy?: readonly string[];
  /** Overrides the catalogue's generic command with a concrete one. */
  readonly investigate?: string;
  readonly remedy?: string;
}

export type FaultListener = (event:
  | { kind: 'raised'; fault: Fault }
  | { kind: 'resolved'; fault: ResolvedFault }
) => void;

/** How many resolved faults to keep for the "recently resolved" view. */
const RESOLVED_HISTORY_LIMIT = 50;

export class FaultRegistry {
  private readonly active = new Map<string, Fault>();
  private readonly resolved: ResolvedFault[] = [];
  private readonly listeners = new Set<FaultListener>();
  /** Injectable for deterministic tests. */
  private clock: () => number = () => Date.now();

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /**
   * Record a fault, or refresh one already recorded. Returns the stored
   * fault either way.
   *
   * Re-raising preserves `since` — a port that flaps five times has been
   * broken since the first flap, not since the last one, and that is the
   * number an operator wants.
   */
  raise(input: RaiseFaultInput): Fault {
    const id = faultId(input.deviceId, input.code, input.scope);
    const entry = catalogEntry(input.code);
    const existing = this.active.get(id);

    const fault: Fault = {
      id,
      code: input.code,
      category: entry.category,
      severity: input.severity ?? entry.severity,
      deviceId: input.deviceId,
      scope: input.scope,
      since: existing?.since ?? this.clock(),
      summary: input.summary,
      investigate: input.investigate ?? entry.investigate,
      remedy: input.remedy ?? entry.remedy,
      causedBy: input.causedBy,
    };
    this.active.set(id, fault);

    // Only log a genuinely new fault: re-raises are the same problem and
    // would otherwise flood the network log on a flapping link.
    if (!existing) {
      Logger[loggerLevelFor(fault.severity)](
        fault.deviceId,
        `fault:${fault.code.toLowerCase()}`,
        fault.summary,
        { scope: fault.scope, severity: fault.severity },
      );
      this.emit({ kind: 'raised', fault });
    }
    return fault;
  }

  /**
   * Clear a fault by its parts. No-op when it was never raised, so a
   * projection can call this unconditionally on the inverse event without
   * tracking what it raised.
   */
  resolve(deviceId: string, code: FaultCode, scope: string): ResolvedFault | null {
    return this.resolveById(faultId(deviceId, code, scope));
  }

  resolveById(id: string): ResolvedFault | null {
    const fault = this.active.get(id);
    if (!fault) return null;
    this.active.delete(id);

    const resolvedAt = this.clock();
    const record: ResolvedFault = {
      ...fault,
      resolvedAt,
      durationMs: resolvedAt - fault.since,
    };
    this.resolved.unshift(record);
    if (this.resolved.length > RESOLVED_HISTORY_LIMIT) {
      this.resolved.length = RESOLVED_HISTORY_LIMIT;
    }
    Logger.info(
      fault.deviceId,
      `fault:resolved`,
      `Resolved: ${fault.summary}`,
      { scope: fault.scope, durationMs: record.durationMs },
    );
    this.emit({ kind: 'resolved', fault: record });
    return record;
  }

  /** Drop every fault of a device — used when the device leaves the topology. */
  resolveAllForDevice(deviceId: string): void {
    for (const fault of [...this.active.values()]) {
      if (fault.deviceId === deviceId) this.resolveById(fault.id);
    }
  }

  /** Drop every fault of a device that matches `code`. */
  resolveAllOfCode(deviceId: string, code: FaultCode): void {
    for (const fault of [...this.active.values()]) {
      if (fault.deviceId === deviceId && fault.code === code) this.resolveById(fault.id);
    }
  }

  // ─── Queries ───────────────────────────────────────────────────

  /** Every active fault, worst severity first then oldest first. */
  list(): readonly Fault[] {
    return [...this.active.values()].sort(compareFaults);
  }

  forDevice(deviceId: string): readonly Fault[] {
    return this.list().filter(f => f.deviceId === deviceId);
  }

  get(id: string): Fault | undefined {
    return this.active.get(id);
  }

  has(deviceId: string, code: FaultCode, scope: string): boolean {
    return this.active.has(faultId(deviceId, code, scope));
  }

  count(severity?: FaultSeverity): number {
    if (!severity) return this.active.size;
    let n = 0;
    for (const f of this.active.values()) if (f.severity === severity) n++;
    return n;
  }

  /** Most-recently-resolved first. */
  recentlyResolved(): readonly ResolvedFault[] {
    return [...this.resolved];
  }

  /**
   * Faults grouped by root cause: each entry is a fault nobody else caused,
   * followed by everything that follows from it. This is what the incident
   * centre renders (docs/PRD-Pannes.md §22.2) — showing eight peer alerts
   * for one pulled cable is exactly what principle U4 forbids.
   */
  grouped(): readonly { root: Fault; consequences: readonly Fault[] }[] {
    const all = this.list();
    const byId = new Map(all.map(f => [f.id, f]));
    const roots = all.filter(f => !f.causedBy?.some(id => byId.has(id)));
    return roots.map(root => ({
      root,
      consequences: all.filter(f => f !== root && f.causedBy?.includes(root.id)),
    }));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  subscribe(listener: FaultListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Wipe everything, including listeners' view. Used by test setup. */
  reset(): void {
    this.active.clear();
    this.resolved.length = 0;
    this.clock = () => Date.now();
  }

  private emit(event: Parameters<FaultListener>[0]): void {
    for (const listener of [...this.listeners]) {
      // A listener that throws must not stop the others, nor unwind into
      // the event handler that raised the fault.
      try { listener(event); } catch { /* isolate */ }
    }
  }
}

function compareFaults(a: Fault, b: Fault): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return a.since - b.since;
}

// ─── Default instance ────────────────────────────────────────────

let defaultRegistry: FaultRegistry | null = null;

export function getFaultRegistry(): FaultRegistry {
  if (!defaultRegistry) defaultRegistry = new FaultRegistry();
  return defaultRegistry;
}

/** Test hook — mirrors `__setDefaultEventBus`. */
export function __setFaultRegistry(registry: FaultRegistry | null): void {
  defaultRegistry = registry;
}

export function resetFaultRegistry(): void {
  defaultRegistry?.reset();
  defaultRegistry = null;
}
