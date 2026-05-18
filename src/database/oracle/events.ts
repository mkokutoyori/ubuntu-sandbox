/**
 * Oracle — reactive event taxonomy (Phase 7 of the reactive refactor).
 *
 * Topics are scoped by `deviceId` so multiple Oracle-bearing servers
 * coexist on the shared bus without cross-talk.
 *
 * Currently emitted alongside the legacy `updateSpfileOnDevice` /
 * `syncAlertLogToDevice` / `syncDatafilesToDevice` /
 * `syncOracleProcessesToDevice` calls. Phase 7's `OracleFilesystemSync`
 * adapter subscribes to these and centralises the FS materialisation.
 */

import type { InstanceState } from './OracleInstance';

// ── Identity ───────────────────────────────────────────────────────────

export interface OracleDeviceRef {
  deviceId: string;
  sid: string;
}

// ── Instance lifecycle ─────────────────────────────────────────────────

export interface OracleInstanceStateChangedPayload extends OracleDeviceRef {
  oldState: InstanceState;
  newState: InstanceState;
}

export interface OracleBackgroundProcessStartedPayload extends OracleDeviceRef {
  name: string;
  pid: number;
  description: string;
}

export interface OracleBackgroundProcessStoppedPayload extends OracleDeviceRef {
  name: string;
  pid: number;
}

export interface OracleAlertLogEntryAddedPayload extends OracleDeviceRef {
  line: string;
}

export interface OracleParameterChangedPayload extends OracleDeviceRef {
  key: string;
  oldValue: string | undefined;
  newValue: string;
  scope: 'MEMORY' | 'SPFILE' | 'BOTH';
}

export interface OracleRedoLogSwitchedPayload extends OracleDeviceRef {
  oldGroup: number;
  newGroup: number;
  sequence: number;
}

export interface OracleArchiveLogCreatedPayload extends OracleDeviceRef {
  sequence: number;
  path: string;
}

// ── Session / transaction / DML / DDL ──────────────────────────────────

export interface OracleSessionConnectedPayload extends OracleDeviceRef {
  sessionId: string;
  schema: string;
  role?: string;
}

export interface OracleSessionDisconnectedPayload extends OracleDeviceRef {
  sessionId: string;
}

export interface OracleSessionRef extends OracleDeviceRef {
  sessionId: string;
}

export interface OracleTxnStartedPayload extends OracleSessionRef {
  txId: number;
}

export interface OracleTxnCommittedPayload extends OracleSessionRef {
  txId: number;
  durationMs: number;
}

export interface OracleTxnRolledBackPayload extends OracleSessionRef {
  txId: number;
}

export interface OracleDmlExecutedPayload extends OracleSessionRef {
  schema: string;
  table: string;
  rowsAffected: number;
}

export interface OracleDdlExecutedPayload extends OracleSessionRef {
  schema: string;
  kind: string;
  name: string;
}

export interface OracleErrorRaisedPayload extends OracleSessionRef {
  code: number;
  message: string;
}

// ── Wait, latch, lock, SQL parse, backup, service events ──────────────
//
// These are the canonical "view-feeding" events: the runtime-state actor
// listens for them and updates the collections backing V$SESSION_WAIT,
// V$LOCK, V$LATCHHOLDER, V$SQLSTATS, V$BACKUP_SET, V$ACTIVE_SERVICES,
// etc. Emitters publish onto the same bus the instance owns.

export interface OracleWaitRecordedPayload extends OracleDeviceRef {
  sid: number;
  sessionId?: string;
  event: string;
  waitClass: string;
  waitTimeMicros: number;
  /** Set when the wait is bound to a known SQL cursor. */
  sqlId?: string;
}

export interface OracleLatchEventPayload extends OracleDeviceRef {
  sid: number;
  latch: string;
  level: number;
  /** acquired / released / sleep. */
  kind: 'acquired' | 'released' | 'sleep';
  spinCount?: number;
}

export interface OracleLockEventPayload extends OracleDeviceRef {
  sid: number;
  sessionId: string;
  type: string;
  id1: number;
  id2: number;
  lmode: number;
  request: number;
  schema?: string;
  table?: string;
  kind: 'acquired' | 'released' | 'wait';
}

export interface OracleSqlParsedPayload extends OracleSessionRef {
  sqlId: string;
  text: string;
  parsingSchema: string;
  hardParse: boolean;
}

export interface OracleSqlExecutedPayload extends OracleSessionRef {
  sqlId: string;
  elapsedMicros: number;
  cpuMicros: number;
  bufferGets: number;
  diskReads: number;
  rowsProcessed: number;
}

export interface OracleBackupRecordedPayload extends OracleDeviceRef {
  /** RMAN-style identifiers carried for V$BACKUP_SET / V$BACKUP_PIECE. */
  setId: number;
  pieceId: number;
  type: 'FULL' | 'INCREMENTAL' | 'ARCHIVELOG' | 'CONTROLFILE' | 'SPFILE';
  handle: string;
  bytes: number;
  startedAt: number;
  completedAt: number;
  status: 'COMPLETED' | 'FAILED';
}

export interface OracleServiceEventPayload extends OracleDeviceRef {
  name: string;
  /** started → active, stopped → archived. */
  kind: 'started' | 'stopped';
}

export interface OracleListenerEventPayload extends OracleDeviceRef {
  state: 'running' | 'stopped';
  endpoint: string;
}

export interface OracleSessionLongopsPayload extends OracleSessionRef {
  opname: string;
  target: string;
  sofar: number;
  totalwork: number;
  units: string;
}

export interface OracleSessionMetricPayload extends OracleDeviceRef {
  sid: number;
  metricName: string;
  value: number;
}

export interface OracleFlashbackEventPayload extends OracleDeviceRef {
  kind: 'enabled' | 'disabled' | 'logged';
  bytes?: number;
  scn?: number;
}

// ── Discriminated union ────────────────────────────────────────────────

export type OracleDomainEvent =
  | { topic: 'oracle.instance.state-changed';            payload: OracleInstanceStateChangedPayload }
  | { topic: 'oracle.instance.background-process-started'; payload: OracleBackgroundProcessStartedPayload }
  | { topic: 'oracle.instance.background-process-stopped'; payload: OracleBackgroundProcessStoppedPayload }
  | { topic: 'oracle.instance.alert-log-entry-added';    payload: OracleAlertLogEntryAddedPayload }
  | { topic: 'oracle.instance.parameter-changed';        payload: OracleParameterChangedPayload }
  | { topic: 'oracle.instance.redo-log-switched';        payload: OracleRedoLogSwitchedPayload }
  | { topic: 'oracle.archive-log.created';               payload: OracleArchiveLogCreatedPayload }
  | { topic: 'oracle.session.connected';                 payload: OracleSessionConnectedPayload }
  | { topic: 'oracle.session.disconnected';              payload: OracleSessionDisconnectedPayload }
  | { topic: 'oracle.transaction.started';               payload: OracleTxnStartedPayload }
  | { topic: 'oracle.transaction.committed';             payload: OracleTxnCommittedPayload }
  | { topic: 'oracle.transaction.rolled-back';           payload: OracleTxnRolledBackPayload }
  | { topic: 'oracle.dml.executed';                      payload: OracleDmlExecutedPayload }
  | { topic: 'oracle.ddl.executed';                      payload: OracleDdlExecutedPayload }
  | { topic: 'oracle.error.raised';                      payload: OracleErrorRaisedPayload }
  | { topic: 'oracle.wait.recorded';                     payload: OracleWaitRecordedPayload }
  | { topic: 'oracle.latch.event';                       payload: OracleLatchEventPayload }
  | { topic: 'oracle.lock.event';                        payload: OracleLockEventPayload }
  | { topic: 'oracle.sql.parsed';                        payload: OracleSqlParsedPayload }
  | { topic: 'oracle.sql.executed';                      payload: OracleSqlExecutedPayload }
  | { topic: 'oracle.backup.recorded';                   payload: OracleBackupRecordedPayload }
  | { topic: 'oracle.service.event';                     payload: OracleServiceEventPayload }
  | { topic: 'oracle.listener.event';                    payload: OracleListenerEventPayload }
  | { topic: 'oracle.session.longops';                   payload: OracleSessionLongopsPayload }
  | { topic: 'oracle.session.metric';                    payload: OracleSessionMetricPayload }
  | { topic: 'oracle.flashback.event';                   payload: OracleFlashbackEventPayload };
