/**
 * JobBuilder — declarative construction of RmanJob with the canonical
 * Oracle step messages. Each builder returns a frozen RmanJob.
 */

import type { RmanJob, JobStep } from './types';
import type { RmanOperation } from '../core/types';

let _jobCounter = 1;

export const JobBuilder = {
  backupDatabase(): RmanJob {
    return _make('BACKUP_DATABASE', [
      { name: 'start_backup',  pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'specify_files', pct: 20, message: 'channel ORA_DISK_1: specifying datafile(s) in backup set' },
      { name: 'backup_what',   pct: 50, message: 'channel ORA_DISK_1: backing up database' },
    ]);
  },

  backupArchivelog(): RmanJob {
    return _make('BACKUP_ARCHIVELOG', [
      { name: 'start_archivelog', pct: 10, message: 'channel ORA_DISK_1: starting archived log backup set' },
      { name: 'specify_archivelogs', pct: 30, message: 'channel ORA_DISK_1: specifying archived log(s) in backup set' },
    ]);
  },

  backupTablespace(tsName: string): RmanJob {
    return _make('BACKUP_TABLESPACE', [
      { name: 'start_backup', pct: 10, message: 'channel ORA_DISK_1: starting full datafile backup set' },
      { name: 'backup_ts',    pct: 50, message: `channel ORA_DISK_1: backing up tablespace ${tsName.toUpperCase()}` },
    ], { tablespace: tsName.toUpperCase() });
  },

  restoreDatabase(): RmanJob {
    return _make('RESTORE_DATABASE', [
      { name: 'start_restore', pct: 10, message: 'channel ORA_DISK_1: starting datafile backup set restore' },
    ]);
  },

  recoverDatabase(): RmanJob {
    return _make('RECOVER_DATABASE', [
      { name: 'start_recover', pct: 20, message: 'starting media recovery' },
    ]);
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

  deleteObsolete(): RmanJob {
    return _make('DELETE_OBSOLETE', [
      { name: 'retention_policy', pct: 30, message: 'RMAN retention policy will be applied to the command' },
      { name: 'using_channel',    pct: 60, message: 'using channel ORA_DISK_1' },
    ]);
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
