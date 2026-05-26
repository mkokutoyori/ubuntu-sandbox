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

/** Logical storage events — emitted whenever the on-disk layout changes. */
export interface OracleTablespaceDatafile {
  path: string;
  size: string;
  autoextend: boolean;
}

export interface OracleTablespaceCreatedPayload extends OracleDeviceRef {
  name: string;
  type: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  datafiles: OracleTablespaceDatafile[];
}

export interface OracleTablespaceDroppedPayload extends OracleDeviceRef {
  name: string;
  type: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  /** Datafile paths that were attached to the tablespace at DROP time. */
  datafiles: string[];
  /** Whether the DROP included `INCLUDING DATAFILES` — drives FS removal. */
  removeDatafiles: boolean;
}

export interface OracleDatafileRenamedPayload extends OracleDeviceRef {
  tablespace: string;
  oldPath: string;
  newPath: string;
}

export interface OracleDatafileResizedPayload extends OracleDeviceRef {
  tablespace: string;
  path: string;
  size: string;
}

export interface OracleDatafileAutoextendChangedPayload extends OracleDeviceRef {
  tablespace: string;
  path: string;
  autoextend: boolean;
}

export interface OracleDatafileAddedPayload extends OracleDeviceRef {
  tablespace: string;
  type: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  path: string;
  size: string;
  autoextend: boolean;
}

export interface OracleTablespaceStatusChangedPayload extends OracleDeviceRef {
  name: string;
  oldStatus: 'ONLINE' | 'OFFLINE' | 'READ ONLY';
  newStatus: 'ONLINE' | 'OFFLINE' | 'READ ONLY';
}

export interface OracleTablespaceRenamedPayload extends OracleDeviceRef {
  oldName: string;
  newName: string;
}

export interface OracleAsmDiskgroupCreatedPayload extends OracleDeviceRef {
  groupNumber: number;
  name: string;
  redundancy: 'EXTERNAL' | 'NORMAL' | 'HIGH';
}

export interface OracleAsmDiskgroupDroppedPayload extends OracleDeviceRef {
  name: string;
  diskPaths: string[];
}

export interface OracleAsmDiskAddedPayload extends OracleDeviceRef {
  diskgroup: string;
  diskNumber: number;
  diskName: string;
  path: string;
  sizeMb: number;
}

export interface OracleAsmDiskDroppedPayload extends OracleDeviceRef {
  diskgroup: string;
  diskName: string;
  path: string;
}

export interface OracleParameterFileRequestedPayload extends OracleDeviceRef {
  target: 'PFILE' | 'SPFILE';
  outputPath: string;
  /** Parameters to render (snapshot at request time). */
  params: Record<string, string>;
}

export interface OracleAuditRecordedPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  actionName: string;
  objOwner: string | null;
  objName: string | null;
  returncode: number;
  sqlText: string | null;
  timestamp: Date;
  osUsername: string;
  userhost: string;
  terminal: string;
}

// ── Security & forensic events ────────────────────────────────────────
//
// These topics are emitted by the SecurityAuditActor and downstream
// detectors. They drive (a) the DBA_* security views and (b) the
// `$ORACLE_BASE/admin/<sid>/security/` log files written by
// OracleFilesystemSync. Producers fire — consumers subscribe.

export interface OracleConnectionTracedPayload extends OracleDeviceRef {
  sessionId: number;
  serial: number;
  username: string;
  osUser: string;
  userhost: string;
  terminal: string;
  program: string;
  ipAddress: string;
  networkProtocol: string;
  authenticationMethod: string;
  authenticationType: string;
  /** 0 on success; an ORA error code (1017, 28000, 1045, 2391, …) on failure. */
  returncode: number;
  outcome: 'SUCCESS' | 'FAILURE' | 'LOGOFF';
  role: 'NORMAL' | 'SYSDBA' | 'SYSOPER';
  timestamp: Date;
  /** True when the connection occurs outside normal business hours
   *  (configurable via SecurityPolicyConfig.businessHours). */
  offHours: boolean;
}

export interface OracleSensitiveAccessPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'EXPORT';
  objectSchema: string;
  objectName: string;
  /** Classification recorded against the object in SensitiveObjectRegistry. */
  classification: 'PII' | 'PCI' | 'PHI' | 'FINANCIAL' | 'CREDENTIALS' | 'CUSTOM';
  rowsAffected: number;
  sqlText: string | null;
  timestamp: Date;
  offHours: boolean;
}

export interface OraclePrivilegeExercisedPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  privilege: string;
  /** What the privilege let the user do (CREATE TABLE, GRANT, ALTER SYSTEM, …). */
  action: string;
  objectSchema: string | null;
  objectName: string | null;
  timestamp: Date;
}

export interface OracleSodViolationPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  policyName: string;
  conflictingPrivileges: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  timestamp: Date;
}

export interface OracleDormantDetectedPayload extends OracleDeviceRef {
  username: string;
  lastLoginAt: Date | null;
  daysSinceLastLogin: number;
  thresholdDays: number;
  accountStatus: string;
  timestamp: Date;
}

export type SecurityAnomalyKind =
  | 'BRUTE_FORCE_ATTEMPT'
  | 'PRIVILEGE_ESCALATION'
  | 'OFF_HOURS_DML'
  | 'MASS_SELECT'
  | 'MASS_DELETE'
  | 'SOD_BREACH'
  | 'SENSITIVE_OBJECT_EXPORT'
  | 'DDL_ON_SYS_OBJECT'
  | 'UNUSUAL_LOGIN_SOURCE'
  | 'DORMANT_ACCOUNT_ACTIVATED'
  | 'FRAUD_PATTERN';

export interface OracleSecurityAnomalyPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  kind: SecurityAnomalyKind;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  evidence: Record<string, string | number | boolean>;
  timestamp: Date;
}

export interface OracleFraudInjectedPayload extends OracleDeviceRef {
  scenario: string;
  /** Free-form summary of what the simulator just did. */
  description: string;
  /** Anomaly kinds the simulator expects the detector to raise. */
  expectedAnomalies: SecurityAnomalyKind[];
  timestamp: Date;
}

export interface OracleDdlHistoryRecordedPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  schema: string;
  /** CREATE TABLE / ALTER USER / DROP INDEX / GRANT / …  */
  kind: string;
  objectType: string | null;
  objectName: string;
  sqlText: string | null;
  /** Monotonic SCN-like sequence allocated by the journal. */
  scn: number;
  timestamp: Date;
}

export interface OracleDmlHistoryRecordedPayload extends OracleDeviceRef {
  sessionId: number;
  username: string;
  schema: string;
  table: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT';
  rowsAffected: number;
  sqlText: string | null;
  scn: number;
  txId: number | null;
  timestamp: Date;
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
  | { topic: 'oracle.flashback.event';                   payload: OracleFlashbackEventPayload }
  | { topic: 'oracle.storage.tablespace-created';        payload: OracleTablespaceCreatedPayload }
  | { topic: 'oracle.storage.tablespace-dropped';        payload: OracleTablespaceDroppedPayload }
  | { topic: 'oracle.storage.datafile-renamed';          payload: OracleDatafileRenamedPayload }
  | { topic: 'oracle.storage.datafile-resized';          payload: OracleDatafileResizedPayload }
  | { topic: 'oracle.storage.datafile-autoextend-changed'; payload: OracleDatafileAutoextendChangedPayload }
  | { topic: 'oracle.storage.datafile-added';            payload: OracleDatafileAddedPayload }
  | { topic: 'oracle.storage.tablespace-status-changed'; payload: OracleTablespaceStatusChangedPayload }
  | { topic: 'oracle.storage.tablespace-renamed';        payload: OracleTablespaceRenamedPayload }
  | { topic: 'oracle.audit.recorded';                    payload: OracleAuditRecordedPayload }
  | { topic: 'oracle.instance.parameter-file-requested'; payload: OracleParameterFileRequestedPayload }
  | { topic: 'oracle.asm.diskgroup-created';             payload: OracleAsmDiskgroupCreatedPayload }
  | { topic: 'oracle.asm.diskgroup-dropped';             payload: OracleAsmDiskgroupDroppedPayload }
  | { topic: 'oracle.asm.disk-added';                    payload: OracleAsmDiskAddedPayload }
  | { topic: 'oracle.asm.disk-dropped';                  payload: OracleAsmDiskDroppedPayload }
  | { topic: 'oracle.security.connection-traced';        payload: OracleConnectionTracedPayload }
  | { topic: 'oracle.security.sensitive-access';         payload: OracleSensitiveAccessPayload }
  | { topic: 'oracle.security.sod-violation';            payload: OracleSodViolationPayload }
  | { topic: 'oracle.security.dormant-detected';         payload: OracleDormantDetectedPayload }
  | { topic: 'oracle.security.anomaly-detected';         payload: OracleSecurityAnomalyPayload }
  | { topic: 'oracle.security.fraud-injected';           payload: OracleFraudInjectedPayload }
  | { topic: 'oracle.privilege.exercised';               payload: OraclePrivilegeExercisedPayload }
  | { topic: 'oracle.ddl.history-recorded';              payload: OracleDdlHistoryRecordedPayload }
  | { topic: 'oracle.dml.history-recorded';              payload: OracleDmlHistoryRecordedPayload };
