/**
 * FilterChain — Chain of Responsibility design pattern, typed and
 * observable.
 *
 * A `FilterChain<T>` is an ordered sequence of named filters that
 * each receive the same context object, may inspect or transform it,
 * and decide the chain's fate (`continue`, `accept`, `drop`, `reject`).
 *
 * Used by:
 *   - IPSec inbound / outbound packet pipelines (Phase 4b2-IPSec).
 *   - ACL evaluation (future).
 *   - Any place where a sequence of pluggable validation /
 *     transformation steps applies.
 *
 * Design:
 *   - Filters are identified by a unique `name`. `add` / `remove` /
 *     `replace` are O(n).
 *   - Each filter is invoked synchronously in order; the verdict
 *     decides whether the chain continues, short-circuits, or
 *     terminates with an error.
 *   - The chain optionally publishes `filterchain.*` events on a
 *     bus for observability (drop reason, reject code, accept).
 *   - Generic over the payload type `T` so it works for any domain.
 *
 * NOT a routing engine: order matters and the chain is linear. For
 * branching workflows use a state machine.
 */

import { type IEventBus, getDefaultEventBus } from '@/events/EventBus';

// ── Verdicts ────────────────────────────────────────────────────────────

/** The filter agrees with the chain's current trajectory; continue. */
export type ContinueVerdict = { readonly kind: 'continue' };

/** Final positive verdict; the chain stops and accepts the payload. */
export type AcceptVerdict<T> = { readonly kind: 'accept'; readonly payload: T };

/** Final positive-but-modified verdict; the chain continues with new payload. */
export type TransformVerdict<T> = { readonly kind: 'transform'; readonly payload: T };

/** Silent drop — no error reported upstream. */
export type DropVerdict = { readonly kind: 'drop'; readonly reason: string };

/** Hard reject — error reported upstream. */
export type RejectVerdict = { readonly kind: 'reject'; readonly code: string; readonly reason: string };

export type FilterVerdict<T> =
  | ContinueVerdict
  | AcceptVerdict<T>
  | TransformVerdict<T>
  | DropVerdict
  | RejectVerdict;

// Convenience verdict constructors.
export const Continue = (): ContinueVerdict => ({ kind: 'continue' });
export const Accept = <T>(payload: T): AcceptVerdict<T> => ({ kind: 'accept', payload });
export const Transform = <T>(payload: T): TransformVerdict<T> => ({ kind: 'transform', payload });
export const Drop = (reason: string): DropVerdict => ({ kind: 'drop', reason });
export const Reject = (code: string, reason: string): RejectVerdict => ({ kind: 'reject', code, reason });

// ── Filter interface ──────────────────────────────────────────────────

/**
 * Single step in a chain. The `apply` function receives the current
 * payload and returns a verdict that tells the chain how to proceed.
 */
export interface Filter<T> {
  readonly name: string;
  apply(payload: T): FilterVerdict<T>;
}

/** Convenience: build a filter from a name + apply function. */
export function makeFilter<T>(name: string, apply: (payload: T) => FilterVerdict<T>): Filter<T> {
  return { name, apply };
}

// ── FilterChain result ────────────────────────────────────────────────

export interface FilterChainOutcome<T> {
  /** Final verdict after the chain completed. */
  readonly verdict: 'accepted' | 'dropped' | 'rejected';
  /** The (possibly transformed) payload. Undefined for dropped/rejected. */
  readonly payload?: T;
  /** Reason text for drops. */
  readonly reason?: string;
  /** Error code for rejects. */
  readonly code?: string;
  /** Names of every filter that ran, in order. */
  readonly trace: ReadonlyArray<string>;
  /** Name of the filter that decided the outcome. */
  readonly decidedBy?: string;
}

// ── FilterChain ────────────────────────────────────────────────────────

export interface FilterChainOptions {
  /** Optional name surfaced in events (e.g. `ipsec.inbound`). */
  readonly chainId?: string;
  /** Optional bus for observability events. Falls back to default. */
  readonly bus?: IEventBus;
  /** Lazy bus provider — used when the bus may change after the chain
   *  is constructed (e.g. `engine.setEventBus(newBus)`). Takes
   *  precedence over `bus` when both are provided. */
  readonly busProvider?: () => IEventBus;
  /** Emit `filterchain.*` events. Default true when a bus is available. */
  readonly emitEvents?: boolean;
}

/**
 * Ordered, observable chain of filters.
 *
 * Behaviour:
 *   - filters run in registration order;
 *   - `continue` → next filter;
 *   - `transform` → next filter sees the new payload;
 *   - `accept` / `drop` / `reject` → chain terminates;
 *   - reaching the end with only `continue` verdicts is treated as
 *     an implicit accept of the final payload.
 */
export class FilterChain<T> {
  private filters: Filter<T>[] = [];
  private readonly chainId: string;
  private readonly busProvider: () => IEventBus;
  private readonly emitEvents: boolean;

  constructor(options: FilterChainOptions = {}) {
    this.chainId = options.chainId ?? 'unnamed';
    if (options.busProvider) {
      this.busProvider = options.busProvider;
    } else if (options.bus) {
      const fixedBus = options.bus;
      this.busProvider = () => fixedBus;
    } else {
      this.busProvider = () => getDefaultEventBus();
    }
    this.emitEvents = options.emitEvents ?? true;
  }

  private get bus(): IEventBus {
    return this.busProvider();
  }

  /** Number of registered filters. */
  size(): number {
    return this.filters.length;
  }

  /** Filter names in order. */
  names(): string[] {
    return this.filters.map((f) => f.name);
  }

  /** Append a filter. Throws if a filter with the same name already exists. */
  add(filter: Filter<T>): this {
    if (this.filters.some((f) => f.name === filter.name)) {
      throw new Error(`FilterChain[${this.chainId}]: duplicate filter '${filter.name}'`);
    }
    this.filters.push(filter);
    return this;
  }

  /** Insert a filter before another filter (by name). */
  addBefore(targetName: string, filter: Filter<T>): this {
    const idx = this.filters.findIndex((f) => f.name === targetName);
    if (idx < 0) throw new Error(`FilterChain[${this.chainId}]: target '${targetName}' not found`);
    if (this.filters.some((f) => f.name === filter.name)) {
      throw new Error(`FilterChain[${this.chainId}]: duplicate filter '${filter.name}'`);
    }
    this.filters.splice(idx, 0, filter);
    return this;
  }

  /** Insert a filter after another filter (by name). */
  addAfter(targetName: string, filter: Filter<T>): this {
    const idx = this.filters.findIndex((f) => f.name === targetName);
    if (idx < 0) throw new Error(`FilterChain[${this.chainId}]: target '${targetName}' not found`);
    if (this.filters.some((f) => f.name === filter.name)) {
      throw new Error(`FilterChain[${this.chainId}]: duplicate filter '${filter.name}'`);
    }
    this.filters.splice(idx + 1, 0, filter);
    return this;
  }

  /** Remove a filter by name. Returns true if a filter was removed. */
  remove(name: string): boolean {
    const before = this.filters.length;
    this.filters = this.filters.filter((f) => f.name !== name);
    return this.filters.length < before;
  }

  /** Replace a filter (in-place). Throws if the target name doesn't exist. */
  replace(filter: Filter<T>): this {
    const idx = this.filters.findIndex((f) => f.name === filter.name);
    if (idx < 0) throw new Error(`FilterChain[${this.chainId}]: '${filter.name}' not found, use add() instead`);
    this.filters[idx] = filter;
    return this;
  }

  /** Empty the chain. */
  clear(): void {
    this.filters = [];
  }

  /**
   * Run the chain on a payload. Always returns an outcome — never throws
   * (filters' exceptions are converted to a `rejected` outcome).
   */
  process(payload: T): FilterChainOutcome<T> {
    let current = payload;
    const trace: string[] = [];

    if (this.emitEvents) {
      this.publishStarted(payload);
    }

    for (const filter of this.filters) {
      trace.push(filter.name);
      let verdict: FilterVerdict<T>;
      try {
        verdict = filter.apply(current);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (this.emitEvents) {
          this.publishCompleted({
            verdict: 'rejected',
            code: 'FILTER_THREW',
            reason: `Filter '${filter.name}' threw: ${reason}`,
            trace,
            decidedBy: filter.name,
          });
        }
        return {
          verdict: 'rejected',
          code: 'FILTER_THREW',
          reason: `Filter '${filter.name}' threw: ${reason}`,
          trace,
          decidedBy: filter.name,
        };
      }

      switch (verdict.kind) {
        case 'continue':
          continue;
        case 'transform':
          current = verdict.payload;
          continue;
        case 'accept': {
          const outcome: FilterChainOutcome<T> = {
            verdict: 'accepted',
            payload: verdict.payload,
            trace,
            decidedBy: filter.name,
          };
          if (this.emitEvents) this.publishCompleted(outcome);
          return outcome;
        }
        case 'drop': {
          const outcome: FilterChainOutcome<T> = {
            verdict: 'dropped',
            reason: verdict.reason,
            trace,
            decidedBy: filter.name,
          };
          if (this.emitEvents) this.publishCompleted(outcome);
          return outcome;
        }
        case 'reject': {
          const outcome: FilterChainOutcome<T> = {
            verdict: 'rejected',
            code: verdict.code,
            reason: verdict.reason,
            trace,
            decidedBy: filter.name,
          };
          if (this.emitEvents) this.publishCompleted(outcome);
          return outcome;
        }
      }
    }

    // Implicit accept: every filter returned `continue`.
    const outcome: FilterChainOutcome<T> = {
      verdict: 'accepted',
      payload: current,
      trace,
    };
    if (this.emitEvents) this.publishCompleted(outcome);
    return outcome;
  }

  // ── Bus observability (Phase 4b2-IPSec) ──────────────────────────

  private publishStarted(payload: T): void {
    this.bus.publish({
      topic: 'log',
      payload: {
        level: 'debug',
        source: `filterchain:${this.chainId}`,
        event: 'started',
        message: `chain ${this.chainId} started`,
        data: { payload: this.serialise(payload) },
      },
    });
  }

  private publishCompleted(outcome: FilterChainOutcome<T>): void {
    this.bus.publish({
      topic: 'log',
      payload: {
        level: outcome.verdict === 'rejected' ? 'warn' : 'debug',
        source: `filterchain:${this.chainId}`,
        event: `completed:${outcome.verdict}`,
        message: outcome.decidedBy
          ? `chain ${this.chainId} ${outcome.verdict} by ${outcome.decidedBy}`
          : `chain ${this.chainId} ${outcome.verdict}`,
        data: {
          trace: outcome.trace,
          decidedBy: outcome.decidedBy,
          reason: outcome.reason,
          code: outcome.code,
        },
      },
    });
  }

  private serialise(payload: T): unknown {
    // Best-effort serialisation for log payload.
    if (payload === null || payload === undefined) return payload;
    if (typeof payload !== 'object') return payload;
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return '[unserialisable]';
    }
  }
}
