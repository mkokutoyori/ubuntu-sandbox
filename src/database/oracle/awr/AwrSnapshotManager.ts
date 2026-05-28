/**
 * AwrSnapshotManager — owns the AWR snapshot collection.
 *
 * Exposes the operations DBMS_WORKLOAD_REPOSITORY wraps:
 *   CREATE_SNAPSHOT   — capture state now
 *   DROP_SNAPSHOT_RANGE — purge a [low_snap_id, high_snap_id] window
 *   MODIFY_SNAPSHOT_SETTINGS — change interval / retention
 *
 * Snapshot capture is event-driven once an MMON-style tick is fired
 * (typically by SQL*Plus `AWR SNAP` directive or DBMS_WORKLOAD_REPOSITORY).
 * The manager itself is passive — it does not auto-snapshot, so tests
 * remain deterministic.
 */

import type { OracleInstance } from '../OracleInstance';
import { AwrSnapshot, type SqlStatSnapshot, type SysStatSnapshot } from './AwrSnapshot';

export interface SnapshotSettings {
  /** Interval in minutes between automatic snapshots. Default 60. */
  intervalMinutes: number;
  /** Retention window in minutes. Default 8 days (11520). */
  retentionMinutes: number;
  /** Topnsql captured per snapshot. Default 30. */
  topnSql: number;
}

export class AwrSnapshotManager {
  private snapshots: AwrSnapshot[] = [];
  private nextSnapId = 1;
  private lastEndInterval: Date;
  /** Tracks previous SQL stats so deltas can be computed. */
  private lastSqlSnapshot = new Map<string, SqlStatSnapshot>();
  private settings: SnapshotSettings = {
    intervalMinutes: 60, retentionMinutes: 8 * 24 * 60, topnSql: 30,
  };

  constructor(private readonly instance: OracleInstance) {
    this.lastEndInterval = instance.startupTime ?? new Date();
  }

  // ── DBMS_WORKLOAD_REPOSITORY routines ─────────────────────────────

  /** CREATE_SNAPSHOT — capture state now. Returns the new snap_id. */
  createSnapshot(opts: { flushLevel?: 'TYPICAL' | 'ALL' | 'BASIC'; manual?: boolean } = {}): number {
    const now = new Date();
    const runtime = this.instance.getRuntimeState();
    const startup = this.instance.startupTime ?? now;

    // Convert runtime counters into a flat list — matches what
    // DBA_HIST_SYSSTAT consumes downstream.
    const c = runtime.counters;
    const sysStats: SysStatSnapshot[] = [
      { statName: 'user commits',           value: c.commits },
      { statName: 'user rollbacks',         value: c.rollbacks },
      { statName: 'execute count',          value: c.executions },
      { statName: 'parse count (total)',    value: c.parseTotal },
      { statName: 'parse count (hard)',     value: c.parseHard },
      { statName: 'redo log space requests',value: c.redoSwitches },
      { statName: 'archive log writes',     value: c.archiveLogs },
      { statName: 'logons cumulative',      value: c.logonsCumulative },
      { statName: 'session logical reads',  value: c.dml * 4 + c.executions * 2 },
      { statName: 'db block changes',       value: c.dml * 3 },
      { statName: 'physical reads',         value: c.executions },
      { statName: 'opened cursors current', value: runtime.sessions.size },
      { statName: 'opened cursors cumulative', value: c.executions },
      { statName: 'sorts (memory)',         value: c.executions },
      { statName: 'sorts (disk)',           value: 0 },
    ];

    // Snapshot the top SQL cache rows.
    const sqlStats: SqlStatSnapshot[] = [];
    for (const sql of runtime.sqlCache.values()) {
      sqlStats.push({
        sqlId: sql.sqlId, text: sql.text, parsingSchema: sql.parsingSchema,
        executions: sql.executions, elapsedMicros: sql.elapsedMicros,
        cpuMicros: sql.cpuMicros, bufferGets: sql.bufferGets,
        diskReads: sql.diskReads, rowsProcessed: sql.rowsProcessed,
      });
    }
    // Keep only the top-N most expensive.
    sqlStats.sort((a, b) => b.elapsedMicros - a.elapsedMicros);
    sqlStats.splice(this.settings.topnSql);
    for (const s of sqlStats) this.lastSqlSnapshot.set(s.sqlId, s);

    const snap = new AwrSnapshot({
      snapId: this.nextSnapId++,
      beginInterval: this.lastEndInterval,
      endInterval: now,
      startupTime: startup,
      snapLevel: opts.flushLevel ?? 'TYPICAL',
      manual: opts.manual ?? true,
      sysStats, sqlStats,
      activeSessions: runtime.sessions.size,
      logonsCumulative: c.logonsCumulative,
    });
    this.snapshots.push(snap);
    this.purgeOld();
    this.lastEndInterval = now;
    this.instance.getBus().publish({
      topic: 'oracle.awr.snapshot-created',
      payload: {
        deviceId: this.instance.getDeviceId(), sid: this.instance.config.sid,
        snapId: snap.snapId, beginInterval: snap.beginInterval,
        endInterval: snap.endInterval, manual: snap.manual,
        flushLevel: snap.snapLevel,
      },
    });
    return snap.snapId;
  }

  /** DROP_SNAPSHOT_RANGE — remove snapshots in [low, high]. */
  dropSnapshotRange(low: number, high: number): number {
    const before = this.snapshots.length;
    this.snapshots = this.snapshots.filter(s => s.snapId < low || s.snapId > high);
    return before - this.snapshots.length;
  }

  /** MODIFY_SNAPSHOT_SETTINGS — change interval / retention / topnsql. */
  modifySettings(s: Partial<SnapshotSettings>): void {
    this.settings = { ...this.settings, ...s };
    this.purgeOld();
  }

  // ── Snapshot APIs ─────────────────────────────────────────────────

  getSnapshots(): readonly AwrSnapshot[] { return this.snapshots; }
  getSnapshot(snapId: number): AwrSnapshot | undefined {
    return this.snapshots.find(s => s.snapId === snapId);
  }
  getSettings(): Readonly<SnapshotSettings> { return this.settings; }

  // ── Internal ──────────────────────────────────────────────────────

  private purgeOld(): void {
    const cutoff = Date.now() - this.settings.retentionMinutes * 60_000;
    this.snapshots = this.snapshots.filter(s => s.endInterval.getTime() >= cutoff);
  }
}
