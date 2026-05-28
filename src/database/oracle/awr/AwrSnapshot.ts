/**
 * AwrSnapshot — concrete representation of one Automatic Workload
 * Repository snapshot.
 *
 * Real Oracle's `WRM$_SNAPSHOT` row carries: snap_id, dbid, instance#,
 * begin/end interval, status, startup_time, flush level. Each snapshot
 * also implicitly captures the per-interval delta of every dynamic
 * performance counter — the simulator does the same by snapshotting
 * the OracleRuntimeState counters and SQL cache at creation time.
 *
 * Stored deltas feed:
 *   DBA_HIST_SYSSTAT         (system counter deltas)
 *   DBA_HIST_SQLSTAT         (per-SQL stats)
 *   DBA_HIST_SYSMETRIC_*     (system metric history)
 *   DBA_HIST_ACTIVE_SESS_HISTORY (active session samples)
 */

export interface SqlStatSnapshot {
  sqlId: string;
  text: string;
  parsingSchema: string;
  executions: number;
  elapsedMicros: number;
  cpuMicros: number;
  bufferGets: number;
  diskReads: number;
  rowsProcessed: number;
}

export interface SysStatSnapshot {
  statName: string;
  value: number;
}

export class AwrSnapshot {
  readonly snapId: number;
  readonly dbid: number;
  readonly instanceNumber: number;
  readonly snapLevel: 'TYPICAL' | 'ALL' | 'BASIC';
  readonly beginInterval: Date;
  readonly endInterval: Date;
  readonly startupTime: Date;
  readonly status: 'COMPLETED' | 'IN PROGRESS' | 'FAILED';
  readonly flushElapsedSeconds: number;
  /** True if produced by DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT. */
  readonly manual: boolean;

  /** Captured system counters at the snapshot's end_interval. */
  readonly sysStats: SysStatSnapshot[];
  /** Captured top SQLs at the snapshot's end_interval. */
  readonly sqlStats: SqlStatSnapshot[];
  /** Captured number of active sessions at the snapshot's end_interval. */
  readonly activeSessions: number;
  /** Cumulative logons since instance start at snapshot time. */
  readonly logonsCumulative: number;

  constructor(init: {
    snapId: number; dbid?: number; instanceNumber?: number;
    snapLevel?: 'TYPICAL' | 'ALL' | 'BASIC';
    beginInterval: Date; endInterval: Date; startupTime: Date;
    manual?: boolean;
    sysStats: SysStatSnapshot[]; sqlStats: SqlStatSnapshot[];
    activeSessions: number; logonsCumulative: number;
  }) {
    this.snapId = init.snapId;
    this.dbid = init.dbid ?? 1;
    this.instanceNumber = init.instanceNumber ?? 1;
    this.snapLevel = init.snapLevel ?? 'TYPICAL';
    this.beginInterval = init.beginInterval;
    this.endInterval = init.endInterval;
    this.startupTime = init.startupTime;
    this.status = 'COMPLETED';
    // Real Oracle records the time the MMON took to flush — we
    // synthesise a small value matching what a healthy install shows.
    this.flushElapsedSeconds = 1;
    this.manual = init.manual ?? false;
    this.sysStats = init.sysStats;
    this.sqlStats = init.sqlStats;
    this.activeSessions = init.activeSessions;
    this.logonsCumulative = init.logonsCumulative;
  }
}
