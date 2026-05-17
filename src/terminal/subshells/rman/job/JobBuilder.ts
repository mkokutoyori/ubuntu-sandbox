/**
 * JobBuilder — declarative construction of RmanJob with the canonical
 * Oracle step messages. Each builder returns a frozen RmanJob.
 */

import type { RmanJob, JobStep } from './types';
import type { RmanOperation } from '../core/types';

let _jobCounter = 1;

export const JobBuilder = {
  backupDatabase(opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.tag)    params.tag    = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'specify_files', pct: 20, message: 'channel ORA_DISK_1: specifying datafile(s) in backup set' },
      { name: 'backup_what',   pct: 50, message: 'channel ORA_DISK_1: backing up database' },
    ], params);
  },

  backupArchivelog(opts: { deleteInput?: boolean; tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.deleteInput) params.deleteInput = 'true';
    if (opts.tag) params.tag = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_ARCHIVELOG', [
      { name: 'start_archivelog', pct: 10, message: 'channel ORA_DISK_1: starting archived log backup set' },
      { name: 'specify_archivelogs', pct: 30, message: 'channel ORA_DISK_1: specifying archived log(s) in backup set' },
    ], params);
  },

  /** Incremental level 0 (full baseline) or level 1 (changes since 0). */
  backupIncremental(level: 0 | 1, opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = { incrementalLevel: String(level) };
    if (opts.tag) params.tag = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: `channel ORA_DISK_1: starting incremental level ${level} datafile backup set` },
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

  backupTablespace(tsName: string, opts: { tag?: string; format?: string } = {}): RmanJob {
    const params: Record<string, string> = { tablespace: tsName.toUpperCase() };
    if (opts.tag)    params.tag    = opts.tag;
    if (opts.format) params.format = opts.format;
    return _make('BACKUP_TABLESPACE', [
      { name: 'start_backup', pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'backup_ts',    pct: 50, message: `channel ORA_DISK_1: backing up tablespace ${tsName.toUpperCase()}` },
    ], params);
  },

  restoreDatabase(): RmanJob {
    return _make('RESTORE_DATABASE', [
      { name: 'start_restore', pct: 10, message: 'channel ORA_DISK_1: starting datafile backup set restore' },
    ]);
  },

  recoverDatabase(opts: { untilScn?: number; untilTime?: string } = {}): RmanJob {
    const params: Record<string, string> = {};
    if (opts.untilScn !== undefined)  params.untilScn  = String(opts.untilScn);
    if (opts.untilTime !== undefined) params.untilTime = opts.untilTime;
    return _make('RECOVER_DATABASE', [
      { name: 'start_recover', pct: 20, message: 'starting media recovery' },
    ], params);
  },

  crosscheck(): RmanJob {
    return _make('CROSSCHECK', [
      { name: 'crosscheck', pct: 80, message: "crosschecked backup piece: found to be 'AVAILABLE'" },
    ]);
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
