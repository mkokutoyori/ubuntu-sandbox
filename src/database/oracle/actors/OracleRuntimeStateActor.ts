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
import type { OracleRuntimeState } from '../views/OracleRuntimeState';

const MAX_WAIT_HISTORY = 1000;
const MAX_ALERT_ENTRIES = 500;

/** FNV-1a 32-bit, lowered to a 13-char base36 sql_id. */
function makeSqlId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const base = h.toString(36).padStart(7, '0');
  return (base + 'a3xqw0kz').slice(0, 13);
}

export class OracleRuntimeStateActor {
  private subs: Unsubscribe[] = [];
  private nextSid = 100;
  private nextSerial = 1;

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly state: OracleRuntimeState,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.state.startedAt = Date.now();

    const scoped = <T extends { deviceId: string }>(handler: (p: T) => void) =>
      (event: { payload: unknown }) => {
        const p = event.payload as T;
        if (p.deviceId !== this.deviceId) return;
        handler(p);
      };

    this.subs.push(
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
        deviceId: string; sessionId: string; schema: string; table: string;
      }>((p) => {
        this.state.counters.dml++;
        this.state.counters.executions++;
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) {
          sess.status = 'ACTIVE';
          const text = `DML on ${p.schema}.${p.table}`;
          this.recordSql(text, sess.schema);
        }
      })),

      this.bus.subscribe('oracle.ddl.executed', scoped<{
        deviceId: string; sessionId: string; schema: string; kind: string; name: string;
      }>((p) => {
        this.state.counters.ddl++;
        this.state.counters.executions++;
        const sess = this.state.sessions.get(p.sessionId);
        if (sess) {
          const text = `${p.kind} ${p.schema}.${p.name}`;
          this.recordSql(text, sess.schema);
        }
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
        if (this.state.alertEntries.length > MAX_ALERT_ENTRIES) {
          this.state.alertEntries.splice(0, this.state.alertEntries.length - MAX_ALERT_ENTRIES);
        }
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
        if (this.state.waitHistory.length > MAX_WAIT_HISTORY) {
          this.state.waitHistory.splice(0, this.state.waitHistory.length - MAX_WAIT_HISTORY);
        }
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
        if (this.state.latches.length > 500) {
          this.state.latches.splice(0, this.state.latches.length - 500);
        }
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
        if (this.state.sessionMetrics.length > 1000) {
          this.state.sessionMetrics.splice(0, this.state.sessionMetrics.length - 1000);
        }
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

  private recordSql(text: string, schema: string): void {
    const sqlId = makeSqlId(text);
    const existing = this.state.sqlCache.get(sqlId);
    const now = Date.now();
    if (existing) {
      existing.executions++;
      existing.lastLoadTime = now;
      existing.bufferGets += 5;
      existing.rowsProcessed += 1;
    } else {
      this.state.sqlCache.set(sqlId, {
        sqlId,
        text,
        parsingSchema: schema,
        executions: 1,
        elapsedMicros: 100,
        cpuMicros: 50,
        bufferGets: 5,
        diskReads: 0,
        rowsProcessed: 1,
        firstLoadTime: now,
        lastLoadTime: now,
      });
      this.state.counters.parseHard++;
    }
    this.state.counters.parseTotal++;
  }

}
