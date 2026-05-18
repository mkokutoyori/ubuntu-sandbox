/**
 * OracleRuntimeStateActor — maintains the `OracleRuntimeState`
 * collections from the `oracle.*` event stream.
 *
 * This is the canonical reactive bridge for the V$/GV$ views: every
 * mutation here is triggered by a domain event that, in a real Oracle
 * server, would feed the equivalent fixed table. The view files
 * themselves only *read* from this state, never mutate it — keeping
 * the registry strictly Open/Closed.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import {
  type OracleRuntimeState,
  type RuntimeStateBudget,
  DEFAULT_RUNTIME_BUDGET,
} from '../views/OracleRuntimeState';
import { makeSqlId } from '../views/sqlId';

/** Trim an array in place to its budget (FIFO eviction). */
function capArray<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/** LRU eviction on a Map keyed by `lastLoadTime`-style timestamp. */
function capSqlCache<T extends { lastLoadTime: number }>(
  cache: Map<string, T>, max: number,
): void {
  if (cache.size <= max) return;
  // Sort entries by ascending lastLoadTime and drop the oldest.
  const entries = [...cache.entries()].sort((a, b) => a[1].lastLoadTime - b[1].lastLoadTime);
  const drop = cache.size - max;
  for (let i = 0; i < drop; i++) cache.delete(entries[i][0]);
}

export class OracleRuntimeStateActor {
  private subs: Unsubscribe[] = [];
  private nextSid = 100;
  private nextSerial = 1;
  /** Bus events processed since last drain — used to schedule drains
   *  without needing a wall-clock timer. */
  private eventsSinceLastDrain = 0;
  /** How often to drain (in handled events). 256 means we sweep once
   *  every ≈256 published events, which keeps drain cost amortised. */
  private static readonly DRAIN_INTERVAL = 256;

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly state: OracleRuntimeState,
    private readonly budget: RuntimeStateBudget = DEFAULT_RUNTIME_BUDGET,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.state.startedAt = Date.now();

    const scoped = <T extends { deviceId: string }>(handler: (p: T) => void) =>
      (event: { payload: unknown }) => {
        const p = event.payload as T;
        if (p.deviceId !== this.deviceId) return;
        handler(p);
        this.tickDrain();
      };

    this.subs.push(
      this.bus.subscribe('oracle.instance.state-changed', scoped<{
        deviceId: string; sid: string; newState: 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';
      }>((p) => {
        if (p.newState === 'SHUTDOWN') this.clearAll();
      })),

      this.bus.subscribe('oracle.session.connected', scoped<{
        deviceId: string; sessionId: string; schema: string; role?: string;
      }>((p) => {
        const sid = this.nextSid++;
        const serial = this.nextSerial++;
        this.state.sessions.set(p.sessionId, {
          sessionId: p.sessionId,
          sid,
          serial,
          username: p.schema.toUpperCase(),
          schema: p.schema.toUpperCase(),
          role: p.role,
          program: 'sqlplus@localhost',
          type: 'USER',
          status: 'INACTIVE',
          logonTime: Date.now(),
          inTransaction: false,
        });
        this.state.counters.logonsCumulative++;
      })),

      this.bus.subscribe('oracle.session.disconnected', scoped<{
        deviceId: string; sessionId: string;
      }>((p) => {
        this.state.sessions.delete(p.sessionId);
      })),

      this.bus.subscribe('oracle.transaction.started', scoped<{
        deviceId: string; sessionId: string; txId: number;
      }>((p) => {
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) sess.inTransaction = true;
        this.state.transactions.set(p.txId, {
          txId: p.txId,
          sessionId: p.sessionId,
          startedAt: Date.now(),
          status: 'ACTIVE',
          usedUblk: 0,
          usedUrec: 0,
        });
      })),

      this.bus.subscribe('oracle.transaction.committed', scoped<{
        deviceId: string; sessionId: string; txId: number;
      }>((p) => {
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) sess.inTransaction = false;
        const tx = this.state.transactions.get(p.txId);
        if (tx) tx.status = 'COMMITTED';
        this.state.transactions.delete(p.txId);
        this.state.counters.commits++;
      })),

      this.bus.subscribe('oracle.transaction.rolled-back', scoped<{
        deviceId: string; sessionId: string; txId: number;
      }>((p) => {
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) sess.inTransaction = false;
        this.state.transactions.delete(p.txId);
        this.state.counters.rollbacks++;
      })),

      this.bus.subscribe('oracle.dml.executed', scoped<{
        deviceId: string; sessionId: string;
      }>((p) => {
        this.state.counters.dml++;
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) sess.status = 'ACTIVE';
      })),

      this.bus.subscribe('oracle.ddl.executed', scoped(() => {
        this.state.counters.ddl++;
      })),

      this.bus.subscribe('oracle.error.raised', scoped(() => {
        this.state.counters.errors++;
      })),

      this.bus.subscribe('oracle.instance.redo-log-switched', scoped(() => {
        this.state.counters.redoSwitches++;
      })),

      this.bus.subscribe('oracle.archive-log.created', scoped<{
        deviceId: string; sequence: number; path: string;
      }>((p) => {
        const recid = this.state.archivedLogs.length + 1;
        const now = Date.now();
        this.state.archivedLogs.push({
          recid,
          name: p.path,
          sequence: p.sequence,
          firstTime: now - 60_000,
          nextTime: now,
        });
        this.state.counters.archiveLogs++;
      })),

      this.bus.subscribe('oracle.instance.alert-log-entry-added', scoped<{
        deviceId: string; line: string;
      }>((p) => {
        this.state.alertEntries.push({ ts: Date.now(), line: p.line });
        capArray(this.state.alertEntries, this.budget.alertEntries);
      })),

      this.bus.subscribe('oracle.wait.recorded', scoped<{
        deviceId: string; sid: number; sessionId?: string; event: string;
        waitClass: string; waitTimeMicros: number; sqlId?: string;
      }>((p) => {
        const seq = this.state.waitHistory.length + 1;
        this.state.waitHistory.push({
          sid: p.sid,
          event: p.event,
          waitClass: p.waitClass,
          seq,
          waitTimeMicros: p.waitTimeMicros,
          timestamp: Date.now(),
        });
        capArray(this.state.waitHistory, this.budget.waitHistory);
        if (p.sessionId) {
          const s = this.state.sessions.get(p.sessionId);
          if (s && p.sqlId) s.lastSqlId = p.sqlId;
        }
      })),

      this.bus.subscribe('oracle.latch.event', scoped<{
        deviceId: string; sid: number; latch: string; level: number;
        kind: 'acquired' | 'released' | 'sleep'; spinCount?: number;
      }>((p) => {
        this.state.latches.push({
          sid: p.sid, latch: p.latch, level: p.level,
          kind: p.kind, spinCount: p.spinCount ?? 0, ts: Date.now(),
        });
        capArray(this.state.latches, this.budget.latches);
      })),

      this.bus.subscribe('oracle.lock.event', scoped<{
        deviceId: string; sid: number; sessionId: string; type: string;
        id1: number; id2: number; lmode: number; request: number;
        schema?: string; table?: string;
        kind: 'acquired' | 'released' | 'wait';
      }>((p) => {
        if (p.kind === 'released') {
          this.state.locks.splice(
            0, this.state.locks.length,
            ...this.state.locks.filter(l =>
              !(l.sid === p.sid && l.type === p.type && l.id1 === p.id1 && l.id2 === p.id2)
            )
          );
          return;
        }
        this.state.locks.push({
          sid: p.sid,
          sessionId: p.sessionId,
          type: p.type,
          id1: p.id1,
          id2: p.id2,
          lmode: p.lmode,
          request: p.request,
          block: p.kind === 'wait' ? 1 : 0,
          schema: p.schema ?? '',
          table: p.table ?? '',
        });
      })),

      this.bus.subscribe('oracle.sql.parsed', scoped<{
        deviceId: string; sessionId: string; sqlId: string; text: string;
        parsingSchema: string; hardParse: boolean;
      }>((p) => {
        const now = Date.now();
        const existing = this.state.sqlCache.get(p.sqlId);
        if (existing) {
          existing.lastLoadTime = now;
        } else {
          this.state.sqlCache.set(p.sqlId, {
            sqlId: p.sqlId,
            text: p.text,
            parsingSchema: p.parsingSchema,
            executions: 0,
            elapsedMicros: 0,
            cpuMicros: 0,
            bufferGets: 0,
            diskReads: 0,
            rowsProcessed: 0,
            firstLoadTime: now,
            lastLoadTime: now,
          });
        }
        this.state.counters.parseTotal++;
        if (p.hardParse) this.state.counters.parseHard++;
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) {
          sess.lastSqlId = p.sqlId;
          sess.lastSqlText = p.text;
        }
      })),

      this.bus.subscribe('oracle.sql.executed', scoped<{
        deviceId: string; sessionId: string; sqlId: string;
        elapsedMicros: number; cpuMicros: number; bufferGets: number;
        diskReads: number; rowsProcessed: number;
      }>((p) => {
        const e = this.state.sqlCache.get(p.sqlId);
        if (e) {
          e.executions++;
          e.elapsedMicros += p.elapsedMicros;
          e.cpuMicros += p.cpuMicros;
          e.bufferGets += p.bufferGets;
          e.diskReads += p.diskReads;
          e.rowsProcessed += p.rowsProcessed;
        }
        this.state.counters.executions++;
      })),

      this.bus.subscribe('oracle.backup.recorded', scoped<{
        deviceId: string; setId: number; pieceId: number; type: string;
        handle: string; bytes: number; startedAt: number; completedAt: number;
        status: string;
      }>((p) => {
        this.state.backups.push({
          setId: p.setId,
          pieceId: p.pieceId,
          type: p.type,
          handle: p.handle,
          bytes: p.bytes,
          startedAt: p.startedAt,
          completedAt: p.completedAt,
          status: p.status,
        });
      })),

      this.bus.subscribe('oracle.service.event', scoped<{
        deviceId: string; name: string; kind: 'started' | 'stopped';
      }>((p) => {
        const rec = this.state.services.get(p.name);
        if (p.kind === 'started') {
          this.state.services.set(p.name, {
            name: p.name, startedAt: Date.now(), active: true,
          });
        } else if (rec) {
          rec.active = false;
        }
      })),

      this.bus.subscribe('oracle.listener.event', scoped<{
        deviceId: string; state: 'running' | 'stopped'; endpoint: string;
      }>((p) => {
        this.state.listenerState = p.state;
        this.state.listenerEndpoint = p.endpoint;
      })),

      this.bus.subscribe('oracle.session.longops', scoped<{
        deviceId: string; sessionId: string; opname: string; target: string;
        sofar: number; totalwork: number; units: string;
      }>((p) => {
        const sess = this.state.sessions.get(p.sessionId);
        if (!sess) return;
        this.state.longops.push({
          sessionId: p.sessionId, sid: sess.sid,
          opname: p.opname, target: p.target,
          sofar: p.sofar, totalwork: p.totalwork, units: p.units,
          ts: Date.now(),
        });
      })),

      this.bus.subscribe('oracle.session.metric', scoped<{
        deviceId: string; sid: number; metricName: string; value: number;
      }>((p) => {
        this.state.sessionMetrics.push({
          sid: p.sid, metric: p.metricName, value: p.value, ts: Date.now(),
        });
        capArray(this.state.sessionMetrics, this.budget.sessionMetrics);
      })),

      this.bus.subscribe('oracle.flashback.event', scoped<{
        deviceId: string; kind: string; bytes?: number; scn?: number;
      }>((p) => {
        this.state.flashbackHistory.push({
          ts: Date.now(),
          kind: p.kind,
          bytes: p.bytes ?? 0,
          scn: p.scn ?? 0,
        });
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  /** Called once per processed event. Triggers a sweep when the
   *  amortised interval is reached. */
  private tickDrain(): void {
    this.eventsSinceLastDrain++;
    if (this.eventsSinceLastDrain >= OracleRuntimeStateActor.DRAIN_INTERVAL) {
      this.drain();
    }
  }

  /**
   * Memory drain — caps every collection and evicts anything older than
   * the TTL window. Safe to call at any time; idempotent.
   *
   * The bus itself uses synchronous dispatch with a bounded re-entrance
   * queue, so the only place memory grows is in the runtime-state
   * collections. Capping them here is the canonical drain mechanism.
   */
  drain(now: number = Date.now()): void {
    this.eventsSinceLastDrain = 0;
    const ttl = this.budget.historyTtlMs;
    const cutoff = now - ttl;

    capArray(this.state.waitHistory, this.budget.waitHistory);
    capArray(this.state.alertEntries, this.budget.alertEntries);
    capArray(this.state.latches, this.budget.latches);
    capArray(this.state.backups, this.budget.backups);
    capArray(this.state.longops, this.budget.longops);
    capArray(this.state.sessionMetrics, this.budget.sessionMetrics);
    capArray(this.state.flashbackHistory, this.budget.flashbackHistory);
    capArray(this.state.archivedLogs, this.budget.archivedLogs);

    capSqlCache(this.state.sqlCache, this.budget.sqlCacheMaxEntries);

    // TTL-based eviction (in-place filter, preserving the same array).
    const ttlPrune = <T>(arr: T[], stamp: (e: T) => number) => {
      let writeIdx = 0;
      for (let i = 0; i < arr.length; i++) {
        if (stamp(arr[i]) >= cutoff) arr[writeIdx++] = arr[i];
      }
      arr.length = writeIdx;
    };
    ttlPrune(this.state.waitHistory, e => e.timestamp);
    ttlPrune(this.state.alertEntries, e => e.ts);
    ttlPrune(this.state.latches, e => e.ts);
    ttlPrune(this.state.longops, e => e.ts);
    ttlPrune(this.state.sessionMetrics, e => e.ts);
    ttlPrune(this.state.flashbackHistory, e => e.ts);

    for (const [k, v] of this.state.sqlCache) {
      if (v.lastLoadTime < cutoff) this.state.sqlCache.delete(k);
    }
  }

  /** Reset all collections — called when the instance shuts down. */
  clearAll(): void {
    this.state.sessions.clear();
    this.state.waitHistory.length = 0;
    this.state.sqlCache.clear();
    this.state.transactions.clear();
    this.state.locks.length = 0;
    this.state.archivedLogs.length = 0;
    this.state.alertEntries.length = 0;
    this.state.latches.length = 0;
    this.state.backups.length = 0;
    this.state.services.clear();
    this.state.longops.length = 0;
    this.state.sessionMetrics.length = 0;
    this.state.flashbackHistory.length = 0;
    const c = this.state.counters;
    c.commits = c.rollbacks = c.dml = c.ddl = c.errors = 0;
    c.redoSwitches = c.archiveLogs = c.logonsCumulative = 0;
    c.parseTotal = c.parseHard = c.executions = 0;
  }
}
