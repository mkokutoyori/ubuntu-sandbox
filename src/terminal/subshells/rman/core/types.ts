/**
 * RmanEvent — central discriminated union of every event published on
 * the per-session RmanEventBus.
 *
 * Producers: RmanJobEngine, ReactiveChannelPool, InMemoryRmanCatalog,
 *            RmanSession (state transitions).
 * Consumers: ReactiveRmanSubShell, optional UI hooks, optional logger.
 */

import type { RmanError } from './RmanError';
import type { BackupKey } from '../values/BackupKey';
import type { RmanTag }   from '../values/RmanTag';
import type { Scn }       from '../values/Scn';

export type RmanOperation =
  | 'BACKUP_DATABASE'
  | 'BACKUP_ARCHIVELOG'
  | 'BACKUP_TABLESPACE'
  | 'RESTORE_DATABASE'
  | 'RECOVER_DATABASE'
  | 'CROSSCHECK'
  | 'DELETE_EXPIRED'
  | 'DELETE_OBSOLETE'
  | 'LIST_BACKUP'
  | 'REPORT_SCHEMA'
  | 'SHOW_ALL'
  | 'CONNECT'
  | 'CONFIGURE';

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED';

export interface BackupPieceInfo {
  readonly key:           BackupKey;
  readonly tag:           RmanTag;
  readonly path:          string;
  readonly sizeBytes:     number;
  readonly checkpointScn: Scn;
}

export type RmanEvent =
  // Session
  | { type: 'SESSION_STATE_CHANGED'; from: RmanSessionState; to: RmanSessionState }
  | { type: 'CONNECTED';             dbId: string; dbName: string; connectedAt: number }
  | { type: 'DISCONNECTED' }
  // Job lifecycle
  | { type: 'JOB_STARTED';    jobId: string; operation: RmanOperation; startedAt: number }
  | { type: 'JOB_COMPLETED';  jobId: string; operation: RmanOperation; elapsedMs: number }
  | { type: 'JOB_FAILED';     jobId: string; operation: RmanOperation; error: RmanError; elapsedMs: number }
  | { type: 'JOB_CANCELLED';  jobId: string; operation: RmanOperation }
  // Progress
  | { type: 'PROGRESS_UPDATED'; jobId: string; stepName: string; pct: number; message: string }
  // Channels
  | { type: 'CHANNEL_ALLOCATED'; channelId: string; sid: number; deviceType: 'DISK' | 'SBT' }
  | { type: 'CHANNEL_RELEASED';  channelId: string }
  | { type: 'CHANNEL_ERROR';     channelId: string; error: RmanError }
  // Backup
  | { type: 'BACKUP_PIECE_STARTED'; jobId: string; channelId: string; what: string }
  | { type: 'BACKUP_PIECE_CREATED'; jobId: string; channelId: string; piece: BackupPieceInfo }
  | { type: 'BACKUP_SET_COMPLETE';  jobId: string; bsKey: number; tag: RmanTag; sizeBytes: number }
  | { type: 'BACKUP_VALIDATED';     jobId: string; what: string }
  | { type: 'ARCHIVELOG_DELETED';   jobId: string; path: string }
  // Restore / Recover
  | { type: 'RESTORE_DATAFILE_STARTED';   jobId: string; channelId: string; fileNo: number; to: string }
  | { type: 'RESTORE_DATAFILE_COMPLETED'; jobId: string; fileNo: number; elapsedMs: number }
  | { type: 'RECOVER_STARTED';            jobId: string; fromScn: Scn }
  | { type: 'RECOVER_COMPLETED';          jobId: string; toScn: Scn; elapsedMs: number }
  // Catalog
  | { type: 'CATALOG_UPDATED'; operation: 'INSERT' | 'DELETE' | 'EXPIRE'; key: BackupKey }
  | { type: 'CROSSCHECK_DONE'; available: number; expired: number }
  // Configuration
  | { type: 'CONFIG_CHANGED'; key: string; oldValue: string; newValue: string }
  // Script parser (future use)
  | { type: 'SCRIPT_LINE_PARSED'; lineNo: number; command: string }
  | { type: 'SCRIPT_BLOCK_START'; blockId: string }
  | { type: 'SCRIPT_BLOCK_END';   blockId: string };
