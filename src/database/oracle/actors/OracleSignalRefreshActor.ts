/**
 * OracleSignalRefreshActor — keeps an `OracleSignalStore` in sync with the
 * `oracle.*` event stream of a given device.
 *
 * Subscribes to the bus, filters events by `deviceId`, and rebuilds the
 * relevant signal. This is the bridge between the bus-side facts and the
 * read-model consumed by React hooks.
 *
 * Lifecycle:
 *   const refresh = new OracleSignalRefreshActor(bus, deviceId, store, opts);
 *   refresh.start();
 *   // … later …
 *   refresh.stop();
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { OracleSignalStore } from '../observables';
import type { InstanceState } from '../OracleInstance';

export interface OracleSignalRefreshOptions {
  /** Maximum lines kept in the alertLog ring buffer (default 200). */
  alertLogBufferSize?: number;
}

export class OracleSignalRefreshActor {
  private subs: Unsubscribe[] = [];
  private alertLines: string[] = [];
  private processes: Map<number, { name: string; pid: number }> = new Map();
  private sessions: Map<string, {
    sessionId: string; schema: string; role?: string; inTransaction: boolean;
  }> = new Map();
  private counters = {
    dml: 0, ddl: 0, commits: 0, rollbacks: 0, errors: 0,
    redoSwitches: 0, archiveLogs: 0,
  };

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: OracleSignalStore,
    private readonly opts: OracleSignalRefreshOptions = {},
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    const max = this.opts.alertLogBufferSize ?? 200;

    // Helper: only react to events scoped to our device.
    const scoped = <T extends { deviceId: string }>(handler: (p: T) => void) =>
      (event: { payload: unknown }) => {
        const p = event.payload as T;
        if (p.deviceId !== this.deviceId) return;
        handler(p);
      };

    this.subs.push(
      this.bus.subscribe('oracle.instance.state-changed', scoped<{ deviceId: string; sid: string; newState: InstanceState }>((p) => {
        this.store.instance.set({
          state: p.newState,
          sid: p.sid,
          startedAt: p.newState === 'SHUTDOWN' ? null : (this.store.instance.get().startedAt ?? Date.now()),
        });
        if (p.newState === 'SHUTDOWN') {
          this.processes.clear();
          this.store.processes.set([]);
        }
      })),

      this.bus.subscribe('oracle.instance.background-process-started', scoped<{ deviceId: string; name: string; pid: number }>((p) => {
        this.processes.set(p.pid, { name: p.name, pid: p.pid });
        this.store.processes.set([...this.processes.values()]);
      })),

      this.bus.subscribe('oracle.instance.background-process-stopped', scoped<{ deviceId: string; pid: number }>((p) => {
        this.processes.delete(p.pid);
        this.store.processes.set([...this.processes.values()]);
      })),

      this.bus.subscribe('oracle.instance.alert-log-entry-added', scoped<{ deviceId: string; line: string }>((p) => {
        this.alertLines.push(p.line);
        if (this.alertLines.length > max) {
          this.alertLines.splice(0, this.alertLines.length - max);
        }
        this.store.alertLog.set({ lines: [...this.alertLines] });
      })),

      this.bus.subscribe('oracle.session.connected', scoped<{
        deviceId: string; sessionId: string; schema: string; role?: string;
      }>((p) => {
        this.sessions.set(p.sessionId, {
          sessionId: p.sessionId, schema: p.schema, role: p.role, inTransaction: false,
        });
        this.flushSessions();
      })),

      this.bus.subscribe('oracle.session.disconnected', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.sessions.delete(p.sessionId);
        this.flushSessions();
      })),

      this.bus.subscribe('oracle.transaction.started', scoped<{ deviceId: string; sessionId: string }>((p) => {
        const s = this.sessions.get(p.sessionId);
        if (s) { s.inTransaction = true; this.flushSessions(); }
      })),
      this.bus.subscribe('oracle.transaction.committed', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.counters.commits++;
        const s = this.sessions.get(p.sessionId);
        if (s) { s.inTransaction = false; this.flushSessions(); }
        this.flushStats();
      })),
      this.bus.subscribe('oracle.transaction.rolled-back', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.counters.rollbacks++;
        const s = this.sessions.get(p.sessionId);
        if (s) { s.inTransaction = false; this.flushSessions(); }
        this.flushStats();
      })),
      this.bus.subscribe('oracle.dml.executed', scoped(() => {
        this.counters.dml++;
        this.flushStats();
      })),
      this.bus.subscribe('oracle.ddl.executed', scoped(() => {
        this.counters.ddl++;
        this.flushStats();
      })),
      this.bus.subscribe('oracle.error.raised', scoped(() => {
        this.counters.errors++;
        this.flushStats();
      })),
      this.bus.subscribe('oracle.instance.redo-log-switched', scoped(() => {
        this.counters.redoSwitches++;
        this.flushStats();
      })),
      this.bus.subscribe('oracle.archive-log.created', scoped(() => {
        this.counters.archiveLogs++;
        this.flushStats();
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  private flushSessions(): void {
    this.store.sessions.set([...this.sessions.values()]);
    this.flushStats();
  }

  private flushStats(): void {
    const activeSessions = this.sessions.size;
    let activeTransactions = 0;
    for (const s of this.sessions.values()) if (s.inTransaction) activeTransactions++;
    this.store.stats.set({
      activeSessions,
      activeTransactions,
      dmlExecuted: this.counters.dml,
      ddlExecuted: this.counters.ddl,
      commits: this.counters.commits,
      rollbacks: this.counters.rollbacks,
      errors: this.counters.errors,
      redoSwitches: this.counters.redoSwitches,
      archiveLogs: this.counters.archiveLogs,
    });
  }
}
