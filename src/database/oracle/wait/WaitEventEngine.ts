/**
 * WaitEventEngine — reactive accumulator that synthesises realistic
 * Oracle wait events from the database's normal activity.
 *
 * Driven by the bus:
 *   • `oracle.sql.parsed`    → "SQL*Net message from client" wait (idle)
 *   • `oracle.sql.executed`  → "db file sequential read" + "SQL*Net
 *                              message to client" depending on workload
 *   • `oracle.dml.executed`  → "db file sequential read" + "db file
 *                              scattered read" for batches
 *   • `oracle.transaction.committed` → "log file sync"
 *   • `oracle.transaction.rolled-back` → "log file sync"
 *   • `oracle.lock.event` kind=wait → "enq: TX - row lock contention"
 *
 * Maintains:
 *   • Per-(sid, event) cumulative totals → V$SESSION_EVENT
 *   • System-wide cumulative totals      → V$SYSTEM_EVENT
 *   • Per-event histogram (10 log buckets) → V$EVENT_HISTOGRAM
 *
 * Each accumulator class is a concrete component with clear
 * responsibilities — Strategy/Observer rather than ad-hoc record
 * keeping.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { KNOWN_WAIT_EVENTS, type WaitClass } from './WaitEvent';

/** One row of V$SESSION_EVENT. */
export interface SessionEventRow {
  sid: number;
  event: string;
  waitClass: string;
  totalWaits: number;
  totalTimeouts: number;
  timeWaitedMicros: number;
  maxWaitMicros: number;
  averageWaitMicros: number;
}

/** One row of V$SYSTEM_EVENT. */
export interface SystemEventRow {
  event: string;
  waitClass: string;
  totalWaits: number;
  totalTimeouts: number;
  timeWaitedMicros: number;
  averageWaitMicros: number;
}

/** One row of V$EVENT_HISTOGRAM. */
export interface EventHistogramRow {
  event: string;
  waitClass: string;
  waitTimeMilliBucket: number; // 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, ...
  waitCount: number;
}

/** Log-2 bucket for a wait in microseconds, mapped to a milli upper bound. */
function bucketForMicros(us: number): number {
  if (us <= 0) return 1;
  const ms = us / 1000;
  let bucket = 1;
  while (bucket < ms) bucket *= 2;
  return bucket;
}

export class WaitEventEngine {
  private readonly sessionStats = new Map<string, SessionEventRow>();
  private readonly systemStats  = new Map<string, SystemEventRow>();
  private readonly histogram    = new Map<string, EventHistogramRow>();
  private subs: Unsubscribe[] = [];

  constructor(private readonly bus: IEventBus, private readonly deviceId: string) {}

  start(): void {
    if (this.subs.length > 0) return;
    const scoped = <P extends { deviceId: string }>(handler: (p: P) => void) =>
      (e: { payload: unknown }) => {
        const p = e.payload as P;
        if (p.deviceId !== this.deviceId) return;
        handler(p);
      };

    this.subs.push(
      // Parse → message from client (Idle); short wait while server idle.
      this.bus.subscribe('oracle.sql.parsed', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.record(parseInt(p.sessionId, 10) || 0, 'SQL*Net message from client', 50);
      })),

      // Execute → realistic disk-read latency, then network back.
      this.bus.subscribe('oracle.sql.executed', scoped<{
        deviceId: string; sessionId: string; bufferGets: number; diskReads: number; rowsProcessed: number;
      }>((p) => {
        const sid = parseInt(p.sessionId, 10) || 0;
        if (p.diskReads > 0) {
          this.record(sid, 'db file sequential read', 80 * Math.max(1, p.diskReads));
        }
        if (p.rowsProcessed > 200) {
          this.record(sid, 'db file scattered read', 240);
        }
        this.record(sid, 'SQL*Net message to client', 10);
      })),

      // DML → log buffer commit later, but each DML hits the buffer cache.
      this.bus.subscribe('oracle.dml.executed', scoped<{
        deviceId: string; sessionId: string; rowsAffected: number;
      }>((p) => {
        const sid = parseInt(p.sessionId, 10) || 0;
        if (p.rowsAffected >= 1000) this.record(sid, 'db file scattered read', 360);
        else this.record(sid, 'db file sequential read', 95);
      })),

      // Commit / rollback → log file sync.
      this.bus.subscribe('oracle.transaction.committed', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.record(parseInt(p.sessionId, 10) || 0, 'log file sync', 1200);
      })),
      this.bus.subscribe('oracle.transaction.rolled-back', scoped<{ deviceId: string; sessionId: string }>((p) => {
        this.record(parseInt(p.sessionId, 10) || 0, 'log file sync', 800);
      })),

      // Lock contention.
      this.bus.subscribe('oracle.lock.event', scoped<{
        deviceId: string; sessionId: string; kind: 'acquired' | 'released' | 'wait';
      }>((p) => {
        if (p.kind !== 'wait') return;
        this.record(parseInt(p.sessionId, 10) || 0, 'enq: TX - row lock contention', 5000);
      })),

      // Shutdown clears the accumulators (real Oracle restarts them).
      this.bus.subscribe('oracle.instance.state-changed', scoped<{ deviceId: string; newState: string }>((p) => {
        if (p.newState === 'SHUTDOWN') this.reset();
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  /** Public record API — testing convenience + future direct emitters. */
  record(sid: number, event: string, waitTimeMicros: number): void {
    const meta = KNOWN_WAIT_EVENTS.find(e => e.name === event);
    if (!meta) return;
    this.updateSession(sid, event, meta.waitClass, waitTimeMicros);
    this.updateSystem(event, meta.waitClass, waitTimeMicros);
    this.updateHistogram(event, meta.waitClass, waitTimeMicros);
  }

  // ── Snapshot APIs (consumed by view files) ────────────────────────

  getSessionEvents(): SessionEventRow[] { return [...this.sessionStats.values()]; }
  getSystemEvents(): SystemEventRow[]   { return [...this.systemStats.values()]; }
  getEventHistogram(): EventHistogramRow[] { return [...this.histogram.values()]; }

  reset(): void {
    this.sessionStats.clear();
    this.systemStats.clear();
    this.histogram.clear();
  }

  // ── Internal updaters ─────────────────────────────────────────────

  private updateSession(sid: number, event: string, waitClass: WaitClass, us: number): void {
    const key = `${sid}|${event}`;
    let row = this.sessionStats.get(key);
    if (!row) {
      row = {
        sid, event, waitClass, totalWaits: 0, totalTimeouts: 0,
        timeWaitedMicros: 0, maxWaitMicros: 0, averageWaitMicros: 0,
      };
      this.sessionStats.set(key, row);
    }
    row.totalWaits++;
    row.timeWaitedMicros += us;
    if (us > row.maxWaitMicros) row.maxWaitMicros = us;
    row.averageWaitMicros = Math.round(row.timeWaitedMicros / row.totalWaits);
  }

  private updateSystem(event: string, waitClass: WaitClass, us: number): void {
    let row = this.systemStats.get(event);
    if (!row) {
      row = { event, waitClass, totalWaits: 0, totalTimeouts: 0, timeWaitedMicros: 0, averageWaitMicros: 0 };
      this.systemStats.set(event, row);
    }
    row.totalWaits++;
    row.timeWaitedMicros += us;
    row.averageWaitMicros = Math.round(row.timeWaitedMicros / row.totalWaits);
  }

  private updateHistogram(event: string, waitClass: WaitClass, us: number): void {
    const bucket = bucketForMicros(us);
    const key = `${event}|${bucket}`;
    let row = this.histogram.get(key);
    if (!row) {
      row = { event, waitClass, waitTimeMilliBucket: bucket, waitCount: 0 };
      this.histogram.set(key, row);
    }
    row.waitCount++;
  }
}
