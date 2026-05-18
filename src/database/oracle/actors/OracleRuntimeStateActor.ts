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

  recordWait(rec: { sid: number; event: string; waitClass: string; waitTimeMicros: number }): void {
    const seq = this.state.waitHistory.length + 1;
    this.state.waitHistory.push({
      sid: rec.sid,
      event: rec.event,
      waitClass: rec.waitClass,
      seq,
      waitTimeMicros: rec.waitTimeMicros,
      timestamp: Date.now(),
    });
    if (this.state.waitHistory.length > MAX_WAIT_HISTORY) {
      this.state.waitHistory.splice(0, this.state.waitHistory.length - MAX_WAIT_HISTORY);
    }
  }
}
