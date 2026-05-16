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
import { ReactiveChannelPool } from '../channel/ReactiveChannelPool';
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

export class RmanSession implements IRmanSession {
  private readonly _bus:        RmanEventBus;
  private readonly _pool:       ReactiveChannelPool;
  private readonly _catalog:    InMemoryRmanCatalog;
  private readonly _engine:     RmanJobEngine;
  private readonly _dispatcher: RmanCommandDispatcher;
  private _state: RmanSessionState = 'IDLE';
  private readonly _unsubs: Array<() => void> = [];
  private _disposed = false;

  readonly events$: RmanObservable<RmanEvent>;

  constructor(
    private readonly _options: RmanSessionOptions,
    private readonly _ctx:     IRmanOracleContext,
  ) {
    this._bus        = new RmanEventBus();
    this._pool       = new ReactiveChannelPool(_options.channelConfigs);
    this._catalog    = new InMemoryRmanCatalog();
    this._engine     = new RmanJobEngine(this._bus, this._pool, this._catalog, _ctx);
    this._dispatcher = new RmanCommandDispatcher();
    this.events$     = this._bus.events$;
    this._wireReactiveStreams();
  }

  get state(): RmanSessionState { return this._state; }

  connect(_target?: string): Result<void, RmanError> {
    if (this._state === 'CONNECTED' || this._state === 'RUNNING_JOB') return ok(undefined);
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
    const upper = trimmed.toUpperCase();

    if (upper === 'EXIT' || upper === 'QUIT') {
      this.dispose();
      return ok(['Recovery Manager complete.']);
    }

    if (upper.startsWith('CONNECT TARGET')) {
      const r = this.connect(trimmed);
      if (!r.ok) return r as Result<string[], RmanError>;
      return ok([`connected to target database: ${this._ctx.dbName} (DBID=${this._ctx.dbId.value})`]);
    }

    if (this._state !== 'CONNECTED' && this._state !== 'RUNNING_JOB') {
      return err({ code: 'RMAN_03002', message: 'target database is not connected' });
    }

    return this._dispatcher.dispatch(trimmed, {
      bus:     this._bus,
      engine:  this._engine,
      catalog: this._catalog,
      ctx:     this._ctx,
      policy:  this._options.retentionPolicy,
    });
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
