/**
 * JobBuilder — declarative construction of RmanJob with the canonical
 * Oracle step messages. Each builder returns a frozen RmanJob.
 */

import type { RmanJob, JobStep } from './types';
import type { RmanOperation } from '../core/types';

let _jobCounter = 1;

export const JobBuilder = {
  backupDatabase(opts: {
    tag?: string; format?: string; compressed?: boolean;
    keepForever?: boolean; keepUntilTime?: string;
    maxPieceSize?: number; encrypted?: boolean;
    notBackedUpNTimes?: number;
    excludeTablespaces?: ReadonlyArray<string>;
  } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.tag)              params.tag           = opts.tag;
    if (opts.format)           params.format        = opts.format;
    if (opts.compressed)       params.compressed    = 'true';
    if (opts.keepForever)      params.keepForever   = 'true';
    if (opts.keepUntilTime)    params.keepUntilTime = opts.keepUntilTime;
    if (opts.maxPieceSize !== undefined) params.maxPieceSize = String(opts.maxPieceSize);
    if (opts.encrypted)        params.encrypted     = 'true';
    if (opts.notBackedUpNTimes !== undefined) params.notBackedUpNTimes = String(opts.notBackedUpNTimes);
    if (opts.excludeTablespaces && opts.excludeTablespaces.length > 0) {
      params.excludeTablespaces = opts.excludeTablespaces.map(s => s.toUpperCase()).join(',');
    }
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'specify_files', pct: 20, message: 'channel ORA_DISK_1: specifying datafile(s) in backup set' },
      { name: 'backup_what',   pct: 50, message: 'channel ORA_DISK_1: backing up database' },
    ], params);
  },

  backupArchivelog(opts: { deleteInput?: boolean; tag?: string; format?: string; fromScn?: number } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.deleteInput)        params.deleteInput = 'true';
    if (opts.tag)                params.tag         = opts.tag;
    if (opts.format)             params.format      = opts.format;
    if (opts.fromScn !== undefined) params.fromScn  = String(opts.fromScn);
    return _make('BACKUP_ARCHIVELOG', [
      { name: 'start_archivelog', pct: 10, message: 'channel ORA_DISK_1: starting archived log backup set' },
      { name: 'specify_archivelogs', pct: 30, message: 'channel ORA_DISK_1: specifying archived log(s) in backup set' },
    ], params);
  },

  /** Incremental level 0 (full baseline) or level 1 (changes since 0). */
  backupIncremental(level: 0 | 1, opts: { tag?: string; format?: string; cumulative?: boolean } = {}): RmanJob {
    const params: Record<string, string> = { incrementalLevel: String(level) };
    if (opts.tag) params.tag = opts.tag;
    if (opts.format) params.format = opts.format;
    if (opts.cumulative) params.cumulative = 'true';
    const cumLabel = opts.cumulative ? ' cumulative' : '';
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: `channel ORA_DISK_1: starting${cumLabel} incremental level ${level} datafile backup set` },
      { name: 'specify_files', pct: 20, message: 'channel ORA_DISK_1: specifying datafile(s) in backup set' },
      { name: 'backup_what',   pct: 50, message: 'channel ORA_DISK_1: backing up database' },
    ], params);
  },

  backupControlfile(opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = { what: 'controlfile' };
    if (opts.tag) params.tag = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'controlfile',   pct: 50, message: 'including current control file in backup set' },
    ], params);
  },

  /** BACKUP VALIDATE DATABASE — no piece written, no catalog change. */
  backupValidate(): RmanJob {
    return _make('BACKUP_DATABASE', [
      { name: 'start_validate', pct: 10, message: 'channel ORA_DISK_1: starting validation of datafile backup set' },
      { name: 'validate_files', pct: 60, message: 'channel ORA_DISK_1: validating files in backup set' },
    ], { validate: 'true' });
  },

  /** VALIDATE (12c+) — scope-aware validation without backup write. */
  validate(opts: {
    scope: 'DATABASE' | 'TABLESPACE' | 'DATAFILE' | 'BACKUPSET';
    tablespace?: string;
    fileNo?: number;
    bsKey?: number;
  }): RmanJob {
    const params: Record<string, string> = { validate: 'true', validateScope: opts.scope };
    if (opts.tablespace) params.tablespace = opts.tablespace.toUpperCase();
    if (opts.fileNo !== undefined) params.fileNo = String(opts.fileNo);
    if (opts.bsKey !== undefined)  params.bsKey  = String(opts.bsKey);
    const label = opts.scope === 'TABLESPACE' ? `tablespace ${opts.tablespace}`
               : opts.scope === 'DATAFILE'   ? `datafile ${opts.fileNo}`
               : opts.scope === 'BACKUPSET'  ? `backupset ${opts.bsKey}`
               :                                'database';
    return _make('BACKUP_DATABASE', [
      { name: 'start_validate', pct: 10, message: `channel ORA_DISK_1: starting validation of ${label}` },
      { name: 'validate_what',  pct: 60, message: `channel ORA_DISK_1: validating ${label}` },
    ], params);
  },

  backupDatafile(fileNos: number | ReadonlyArray<number>, opts: { tag?: string; format?: string; compressed?: boolean } = {}): RmanJob {
    const list = Array.isArray(fileNos) ? fileNos : [fileNos as number];
    const params: Record<string, string> = { fileNo: list.join(',') };
    if (opts.tag)        params.tag        = opts.tag;
    if (opts.format)     params.format     = opts.format;
    if (opts.compressed) params.compressed = 'true';
    const label = list.length === 1 ? `datafile ${list[0]}` : `datafiles ${list.join(', ')}`;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: `channel ORA_DISK_1: starting full ${label} backup set` },
      { name: 'specify_file',  pct: 20, message: `channel ORA_DISK_1: specifying ${label}` },
    ], params);
  },

  backupSpfile(opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = { what: 'spfile' };
    if (opts.tag)    params.tag    = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup', pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'spfile',       pct: 50, message: 'including current SPFILE in backup set' },
    ], params);
  },

  backupTablespace(tsName: string | ReadonlyArray<string>, opts: { tag?: string; format?: string } = {}): RmanJob {
    const list = (Array.isArray(tsName) ? tsName : [tsName as string]).map(s => s.toUpperCase());
    const params: Record<string, string> = { tablespace: list.join(',') };
    if (opts.tag)    params.tag    = opts.tag;
    if (opts.format) params.format = opts.format;
    const label = list.length === 1 ? `tablespace ${list[0]}` : `tablespaces ${list.join(', ')}`;
    return _make('BACKUP_TABLESPACE', [
      { name: 'start_backup', pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'backup_ts',    pct: 50, message: `channel ORA_DISK_1: backing up ${label}` },
    ], params);
  },

  /** BACKUP RECOVERY AREA — sauve toute la FRA (FULL+archives+CF). */
  backupRecoveryArea(opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = { what: 'recoveryArea' };
    if (opts.tag)    params.tag    = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',    pct: 10, message: 'channel ORA_DISK_1: starting recovery area backup' },
      { name: 'flash_recovery',  pct: 30, message: 'channel ORA_DISK_1: scanning recovery area' },
      { name: 'backup_what',     pct: 60, message: 'channel ORA_DISK_1: backing up recovery area contents' },
    ], params);
  },

  restoreDatabase(opts: { tag?: string; preview?: boolean; validate?: boolean } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.tag)      params.tag      = opts.tag;
    if (opts.preview)  params.preview  = 'true';
    if (opts.validate) params.validate = 'true';
    return _make('RESTORE_DATABASE', [
      { name: 'start_restore', pct: 10, message: 'channel ORA_DISK_1: starting datafile backup set restore' },
    ], Object.keys(params).length ? params : undefined);
  },

  restoreTablespace(ts: string, opts: { tag?: string; preview?: boolean; validate?: boolean } = {}): RmanJob {
    const params: Record<string, string> = { tablespace: ts.toUpperCase() };
    if (opts.tag)      params.tag      = opts.tag;
    if (opts.preview)  params.preview  = 'true';
    if (opts.validate) params.validate = 'true';
    return _make('RESTORE_DATABASE', [
      { name: 'start_restore', pct: 10, message: `channel ORA_DISK_1: starting tablespace ${ts.toUpperCase()} restore` },
    ], params);
  },

  restoreDatafile(fileNo: number, opts: { tag?: string; preview?: boolean; validate?: boolean } = {}): RmanJob {
    const params: Record<string, string> = { fileNo: String(fileNo) };
    if (opts.tag)      params.tag      = opts.tag;
    if (opts.preview)  params.preview  = 'true';
    if (opts.validate) params.validate = 'true';
    return _make('RESTORE_DATABASE', [
      { name: 'start_restore', pct: 10, message: `channel ORA_DISK_1: starting datafile ${fileNo} restore` },
    ], params);
  },

  duplicateDatabase(targetDbName: string): RmanJob {
    return _make('DUPLICATE_DATABASE', [
      { name: 'start_duplicate',  pct: 10, message: `Starting Duplicate Db at ${new Date().toISOString()}` },
      { name: 'set_auxiliary',    pct: 20, message: `contents of Memory Script: { set newname for datafiles }` },
      { name: 'restore_clone',    pct: 60, message: 'restore clone database' },
      { name: 'switch_clone',     pct: 80, message: 'switch clone datafile' },
    ], { auxiliary: targetDbName });
  },

  recoverDatabase(opts: {
    untilScn?: number; untilTime?: string; untilCancel?: boolean;
    tablespace?: string; fileNo?: number;
  } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.untilScn !== undefined)  params.untilScn   = String(opts.untilScn);
    if (opts.untilTime !== undefined) params.untilTime  = opts.untilTime;
    if (opts.untilCancel)             params.untilCancel = 'true';
    if (opts.tablespace !== undefined) params.tablespace = opts.tablespace.toUpperCase();
    if (opts.fileNo     !== undefined) params.fileNo     = String(opts.fileNo);
    return _make('RECOVER_DATABASE', [
      { name: 'start_recover', pct: 20, message: 'starting media recovery' },
    ], params);
  },

  crosscheck(scope: 'BACKUP' | 'ARCHIVELOG' = 'BACKUP'): RmanJob {
    const msg = scope === 'ARCHIVELOG'
      ? "crosschecked archived log: found to be 'AVAILABLE'"
      : "crosschecked backup piece: found to be 'AVAILABLE'";
    return _make('CROSSCHECK', [
      { name: 'crosscheck', pct: 80, message: msg },
    ], { scope });
  },

  deleteExpired(): RmanJob {
    return _make('DELETE_EXPIRED', [
      { name: 'using_channel', pct: 50, message: 'using channel ORA_DISK_1' },
    ]);
  },

  /**
   * deleteObsolete with an explicit set of bsKeys to delete. Callers
   * (DeleteCommand) compute the list via the active IRetentionPolicy.
   */
  deleteObsolete(setKeys: number[] = []): RmanJob {
    return _make('DELETE_OBSOLETE', [
      { name: 'retention_policy', pct: 30, message: 'RMAN retention policy will be applied to the command' },
      { name: 'using_channel',    pct: 60, message: 'using channel ORA_DISK_1' },
    ], { setKeys: setKeys.join(',') });
  },
};

function _make(
  operation: RmanOperation,
  steps: JobStep[],
  params?: Record<string, string>,
): RmanJob {
  return Object.freeze({
    id:        `JOB-${_jobCounter++}`,
    operation,
    steps:     Object.freeze(steps.map(s => Object.freeze({ ...s }))),
    startedAt: Date.now(),
    params:    params ? Object.freeze({ ...params }) : undefined,
  });
}
