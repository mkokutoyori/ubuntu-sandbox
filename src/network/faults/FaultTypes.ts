/**
 * FaultTypes — the vocabulary of the incident registry
 * (docs/PRD-Pannes.md §6.1).
 *
 * A `Fault` is the *current* state of something that is wrong, not a log
 * line about something that happened. The distinction drives the whole
 * design: faults are raised, deduplicated by identity, and resolved when
 * the inverse event arrives — they are never appended to a list.
 */

/**
 * Severity is decided by the CONSEQUENCE, never by the cause
 * (docs/PRD-Pannes.md §5, principle P7). A carrier loss on an unused port
 * is a `notice`; the same loss on the only uplink is `critical`.
 */
export type FaultSeverity = 'critical' | 'degraded' | 'notice';

/**
 * Catalogue of modelled failure kinds. Kept as a closed union rather than
 * free-form strings so the UI can exhaustively map code → presentation and
 * the compiler catches a code added without a catalogue entry.
 *
 * Only the codes Phase 1 can actually raise are declared here; the rest of
 * docs/PRD-Pannes.md §28.2 lands with the phase that implements it, so an
 * unimplemented code is never silently referenced.
 */
export type FaultCode =
  // ── Physical (F1) ──────────────────────────────────────────────
  | 'LINK_DOWN'
  | 'LINK_ADMIN_DOWN'
  | 'LINK_ERRDISABLE'
  // ── Power (F2) ─────────────────────────────────────────────────
  | 'DEVICE_POWERED_OFF'
  // ── Services (F6) ──────────────────────────────────────────────
  | 'SERVICE_FAILED'
  | 'SERVICE_START_LIMITED';

/** Broad family, used by the UI to group and filter. */
export type FaultCategory = 'physical' | 'power' | 'switching' | 'routing'
  | 'process' | 'service' | 'filesystem' | 'identity' | 'resource' | 'application';

export interface Fault {
  /**
   * Stable identity: `${deviceId}:${code}:${scope}`. Two events describing
   * the same broken thing produce the same id, which is what makes raising
   * idempotent — a port flapping does not accumulate incidents.
   */
  readonly id: string;
  readonly code: FaultCode;
  readonly category: FaultCategory;
  readonly severity: FaultSeverity;
  readonly deviceId: string;
  /** The resource at fault: port name, unit name, file path, … */
  readonly scope: string;
  /** Epoch ms of the first raise. Preserved across re-raises. */
  readonly since: number;
  /**
   * One line, worded like the real tool would word it
   * (docs/PRD-Pannes.md §5, principle P3). Never translated — this is what
   * the learner will meet on a real system.
   */
  readonly summary: string;
  /** Command an operator would run to investigate. */
  readonly investigate?: string;
  /** Command or gesture that repairs it. */
  readonly remedy?: string;
  /**
   * Ids of the faults this one follows from. Lets the UI show "1 cause,
   * 7 consequences" instead of eight peer alerts
   * (docs/PRD-Pannes.md §18.2, principle U4).
   */
  readonly causedBy?: readonly string[];
}

/** A resolved fault, kept for the "recently resolved" view. */
export interface ResolvedFault extends Fault {
  readonly resolvedAt: number;
  /** Milliseconds between `since` and `resolvedAt`. */
  readonly durationMs: number;
}

/** Static presentation data for a code — no runtime state. */
export interface FaultCatalogEntry {
  readonly category: FaultCategory;
  readonly severity: FaultSeverity;
  /** Short human label for the UI (translatable, unlike `summary`). */
  readonly label: string;
  readonly investigate?: string;
  readonly remedy?: string;
}

export const SEVERITY_ORDER: Readonly<Record<FaultSeverity, number>> = {
  critical: 0,
  degraded: 1,
  notice: 2,
};

/** Highest severity among the given faults, or null when there are none. */
export function maxSeverity(faults: readonly Fault[]): FaultSeverity | null {
  let worst: FaultSeverity | null = null;
  for (const f of faults) {
    if (worst === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst]) {
      worst = f.severity;
    }
  }
  return worst;
}

/** The `Logger` level a severity projects onto (docs/PRD-Pannes.md §3.1). */
export function loggerLevelFor(severity: FaultSeverity): 'error' | 'warn' | 'info' {
  switch (severity) {
    case 'critical': return 'error';
    case 'degraded': return 'warn';
    case 'notice': return 'info';
  }
}

export function faultId(deviceId: string, code: FaultCode, scope: string): string {
  return `${deviceId}:${code}:${scope}`;
}
