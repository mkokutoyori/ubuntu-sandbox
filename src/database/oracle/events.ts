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
  | { topic: 'oracle.error.raised';                      payload: OracleErrorRaisedPayload };
