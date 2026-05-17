/**
 * RmanSession — Reactive Facade + state machine.
 *
 * Wires together the bus, the channel pool, the catalog, the job
 * engine, and the command dispatcher. Owns the session's state.
 * Forwards channel + catalog streams onto the central bus so external
 * subscribers see a single stream.
 *
 * State machine:
 *   IDLE ──connect()──▶ CONNECTING ──▶ CONNECTED
 *   CONNECTED ──JOB_STARTED──▶ RUNNING_JOB ──JOB_COMPLETED/FAILED──▶ CONNECTED
 *   any ──dispose()/EXIT──▶ DISCONNECTED
 */

import { RmanEventBus } from '../reactive/RmanEventBus';
import { createAggregations, type ReactiveAggregations, type SessionMetrics } from '../reactive/aggregations';
import { ReactiveChannelPool } from '../channel/ReactiveChannelPool';
import { RmanBusBridge } from '../RmanBusBridge';
import { InMemoryRmanCatalog } from '../catalog/InMemoryRmanCatalog';
import { RmanJobEngine } from '../job/RmanJobEngine';
import { RmanCommandDispatcher } from '../commands/RmanCommandDispatcher';
import { ok, err, type Result } from '../core/Result';
import { formatOracleDate } from '../core/pureUtils';
import type { RmanError } from '../core/RmanError';
import type { IRmanSession } from './IRmanSession';
import type { RmanSessionOptions, RmanSessionState } from './types';
import type { IRmanOracleContext } from '../integration/IRmanOracleContext';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';
import { RmanSessionOptionsBuilder } from './RmanSessionOptionsBuilder';
import { RmanConfig } from './RmanConfig';

export class RmanSession implements IRmanSession {
  private readonly _bus:        RmanEventBus;
  private readonly _pool:       ReactiveChannelPool;
  private readonly _catalog:    InMemoryRmanCatalog;
  private readonly _engine:     RmanJobEngine;
  private readonly _dispatcher: RmanCommandDispatcher;
  private readonly _config:     RmanConfig;
  /** Lines accumulated inside an active RUN { ... } block. */
  private readonly _block:      string[] = [];
  private _inBlock = false;
  /** User-aliased channels held by ALLOCATE CHANNEL. */
  private readonly _userChannels = new Map<string, import('../channel/types').ChannelHandle>();
  private _state: RmanSessionState = 'IDLE';
  private readonly _unsubs: Array<() => void> = [];
  private _disposed = false;

  readonly events$:        RmanObservable<RmanEvent>;
  readonly metrics$:        RmanObservable<SessionMetrics>;
  readonly activeJob$:      RmanObservable<string | null>;
  readonly activeChannels$: RmanObservable<ReadonlySet<string>>;
  private readonly _aggregations: ReactiveAggregations;
  private readonly _bridge?: RmanBusBridge;
  readonly sessionId: string;

  constructor(
    private readonly _options: RmanSessionOptions,
    private readonly _ctx:     IRmanOracleContext,
  ) {
    this._bus        = new RmanEventBus();
    this._pool       = new ReactiveChannelPool(_options.channelConfigs);
    this._catalog    = new InMemoryRmanCatalog();
    this._engine     = new RmanJobEngine(this._bus, this._pool, this._catalog, _ctx);
    this._dispatcher = new RmanCommandDispatcher();
    this._config     = new RmanConfig(_options.retentionPolicy, _options.autobackupCf);
    this.events$     = this._bus.events$;
    this._wireReactiveStreams();
    // Derived state — must subscribe after _wireReactiveStreams so that
    // channel/catalog forwards are already feeding events$.
    this._aggregations    = createAggregations(this.events$);
    this.metrics$         = this._aggregations.metrics$;
    this.activeJob$       = this._aggregations.activeJob$;
    this.activeChannels$  = this._aggregations.activeChannels$;

    this.sessionId = _options.sessionId ?? `rman-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (_options.sharedBus) {
      this._bridge = new RmanBusBridge(_options.sharedBus, this.sessionId, this.events$);
      this._bridge.start();
    }
  }

  get state(): RmanSessionState { return this._state; }

  connect(_target?: string): Result<void, RmanError> {
    if (this._state === 'CONNECTED' || this._state === 'RUNNING_JOB') return ok(undefined);
    const inst = this._ctx.getInstanceState?.();
    if (inst === 'SHUTDOWN') {
      return err({ code: 'RMAN_04014', message: 'Oracle instance is not started' });
    }
    this._transition('CONNECTING');
    this._transition('CONNECTED');
    this._bus.emit({
      type: 'CONNECTED',
      dbId: String(this._options.dbId.value),
      dbName: this._options.dbId.name,
      connectedAt: Date.now(),
    });
    return ok(undefined);
  }

  processLine(line: string): Result<string[], RmanError> {
    const trimmed = line.trim();
    if (!trimmed) return ok([]);
    if (trimmed.startsWith('#')) return ok([]); // comment

    const upper = trimmed.toUpperCase();

    // Block control — recognised in any state, before the connection check.
    if (upper === 'RUN' || upper === 'RUN {' || trimmed === '{') {
      this._inBlock = true;
      this._block.length = 0;
      return ok([]);
    }
    if (trimmed === '}') {
      if (!this._inBlock) {
        return err({ code: 'RMAN_00558', message: 'syntax error: unexpected "}" outside RUN block' });
      }
      const lines = [...this._block];
      this._block.length = 0;
      this._inBlock = false;
      return this._runBlock(lines);
    }

    if (this._inBlock) {
      // Drop trailing ; just like a single-line command would.
      const cmd = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
      if (cmd) this._block.push(cmd);
      return ok([]);
    }

    // One-shot line — strip optional trailing semicolon.
    const cleaned = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
    const cleanedUpper = cleaned.toUpperCase();

    if (cleanedUpper === 'EXIT' || cleanedUpper === 'QUIT') {
      this.dispose();
      return ok(['Recovery Manager complete.']);
    }

    if (cleanedUpper.startsWith('CONNECT TARGET')) {
      const r = this.connect(cleaned);
      if (!r.ok) return r as Result<string[], RmanError>;
      return ok([`connected to target database: ${this._ctx.dbName} (DBID=${this._ctx.dbId.value})`]);
    }

    if (this._state !== 'CONNECTED' && this._state !== 'RUNNING_JOB') {
      return err({ code: 'RMAN_03002', message: 'target database is not connected' });
    }

    return this._dispatcher.dispatch(cleaned, this._cmdCtx());
  }

  private _cmdCtx() {
    return {
      bus:     this._bus,
      engine:  this._engine,
      catalog: this._catalog,
      ctx:     this._ctx,
      policy:  this._config.snapshot().retentionPolicy,
      config:  this._config,
      pool:    this._pool,
      userChannels: this._userChannels,
    };
  }

  /** Execute every accumulated line of a RUN { ... } block in order. */
  private _runBlock(lines: string[]): Result<string[], RmanError> {
    if (this._state !== 'CONNECTED' && this._state !== 'RUNNING_JOB') {
      return err({ code: 'RMAN_03002', message: 'target database is not connected' });
    }
    const output: string[] = [];
    for (const cmd of lines) {
      const r = this._dispatcher.dispatch(cmd, this._cmdCtx());
      if (!r.ok) return r;
      output.push(...r.value);
    }
    return ok(output);
  }

  getBanner(): string[] {
    return [
      '',
      `Recovery Manager: Release 19.0.0.0.0 - Production on ${formatOracleDate()}`,
      '',
      'Copyright (c) 1982, 2024, Oracle and/or its affiliates.  All rights reserved.',
      '',
    ];
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._state !== 'DISCONNECTED') this._transition('DISCONNECTED');
    this._bus.emit({ type: 'DISCONNECTED' });
    for (const u of this._unsubs) u();
    this._aggregations.dispose();
    this._bridge?.stop();
    this._pool.dispose();
    this._catalog.dispose();
    this._bus.dispose();
  }

  // ── Internal wiring ──────────────────────────────────────────────

  private _wireReactiveStreams(): void {
    this._unsubs.push(
      this._bus.jobStarted$.subscribe(() => {
        if (this._state === 'CONNECTED') this._transition('RUNNING_JOB');
      }),
      this._bus.jobCompleted$.subscribe(() => {
        if (this._state === 'RUNNING_JOB') this._transition('CONNECTED');
      }),
      this._bus.jobFailed$.subscribe(() => {
        if (this._state === 'RUNNING_JOB') this._transition('CONNECTED');
      }),
      this._pool.allocations$.subscribe(e => this._bus.emit(e)),
      this._pool.releases$.subscribe(e   => this._bus.emit(e)),
      this._catalog.changes$.subscribe(e => this._bus.emit(e)),
    );
  }

  private _transition(to: RmanSessionState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this._bus.emit({ type: 'SESSION_STATE_CHANGED', from, to });
  }
}

// ── Static factory ────────────────────────────────────────────────────

export namespace RmanSession {
  /**
   * Build a session with sensible defaults; auto-connects when "target"
   * appears in `args`. Returns the session + the RMAN banner.
   */
  export function create(
    args: string[],
    ctx: IRmanOracleContext,
    customise?: (builder: RmanSessionOptionsBuilder) => void,
  ): { session: RmanSession; banner: string[] } {
    const builder = new RmanSessionOptionsBuilder().withDbId(ctx.dbId);
    customise?.(builder);
    const session = new RmanSession(builder.build(), ctx);
    const banner = session.getBanner();
    const targetIdx = args.findIndex(a => a.toUpperCase() === 'TARGET');
    if (targetIdx !== -1) {
      session.connect(args[targetIdx + 1] ?? '/');
      banner.push(`connected to target database: ${ctx.dbName} (DBID=${ctx.dbId.value})`);
      banner.push('');
    }
    return { session, banner };
  }
}
