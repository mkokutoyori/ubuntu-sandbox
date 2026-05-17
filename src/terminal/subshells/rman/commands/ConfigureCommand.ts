/**
 * ConfigureCommand — parses CONFIGURE clauses and mutates the live
 * RmanConfig owned by the session.
 *
 * Supported forms (case-insensitive):
 *   CONFIGURE RETENTION POLICY TO REDUNDANCY <n>
 *   CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF <n> DAYS
 *   CONFIGURE RETENTION POLICY TO NONE
 *   CONFIGURE CONTROLFILE AUTOBACKUP ON|OFF
 *   CONFIGURE DEVICE TYPE DISK PARALLELISM <n>
 *   CONFIGURE DEFAULT DEVICE TYPE TO DISK|SBT
 *   CONFIGURE BACKUP OPTIMIZATION ON|OFF
 *   CONFIGURE MAXSETSIZE TO UNLIMITED|<n>[KMGT]
 *   CONFIGURE COMPRESSION ALGORITHM '<BASIC|LOW|MEDIUM|HIGH>'
 *   CONFIGURE ENCRYPTION FOR DATABASE ON|OFF
 *
 * Returns ok(string[]) with a single Oracle-style "new RMAN
 * configuration parameters are successfully stored" message; the
 * actual SHOW ALL line update happens via the live snapshot.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { RedundancyPolicy } from '../policy/RedundancyPolicy';
import { RecoveryWindowPolicy } from '../policy/RecoveryWindowPolicy';
import { NonePolicy } from '../policy/NonePolicy';
import type { ConfigDelta } from '../session/RmanConfig';

export class ConfigureCommand implements IRmanCommand<string[]> {
  readonly name = 'CONFIGURE';

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const text = (args[0] ?? '').trim();
    const upper = text.toUpperCase();
    const cfg = cmdCtx.config;
    if (!cfg) {
      return err({ code: 'RMAN_00558', message: 'CONFIGURE requires a session-scoped config' });
    }

    let delta: ConfigDelta | null = null;

    // RETENTION POLICY ──────────────────────────────────────────────
    const mRed = upper.match(/^RETENTION POLICY TO REDUNDANCY (\d+)$/);
    if (mRed) {
      const n = parseInt(mRed[1], 10);
      if (n < 1) return err({ code: 'RMAN_00558', message: `invalid REDUNDANCY ${n}` });
      delta = cfg.setRetentionPolicy(new RedundancyPolicy(n));
    }
    const mWin = upper.match(/^RETENTION POLICY TO RECOVERY WINDOW OF (\d+) DAYS?$/);
    if (mWin) {
      const d = parseInt(mWin[1], 10);
      if (d < 1) return err({ code: 'RMAN_00558', message: `invalid RECOVERY WINDOW ${d}` });
      delta = cfg.setRetentionPolicy(new RecoveryWindowPolicy(d));
    }
    if (upper === 'RETENTION POLICY TO NONE') {
      delta = cfg.setRetentionPolicy(new NonePolicy());
    }
    // CONTROLFILE AUTOBACKUP ────────────────────────────────────────
    if (upper === 'CONTROLFILE AUTOBACKUP ON')  delta = cfg.setControlfileAutobackup(true);
    if (upper === 'CONTROLFILE AUTOBACKUP OFF') delta = cfg.setControlfileAutobackup(false);
    const mCfFmt = text.match(/^CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE (DISK|SBT) TO '([^']+)'$/i);
    if (mCfFmt) delta = cfg.setControlfileAutobackupFormat(mCfFmt[2]);
    // DEVICE TYPE PARALLELISM ───────────────────────────────────────
    const mPar = upper.match(/^DEVICE TYPE (DISK|SBT) PARALLELISM (\d+)(?: BACKUP TYPE TO (BACKUPSET|COMPRESSED BACKUPSET|COPY))?$/);
    if (mPar) {
      const n = parseInt(mPar[2], 10);
      if (n < 1) return err({ code: 'RMAN_00558', message: `invalid PARALLELISM ${n}` });
      delta = cfg.setDeviceParallelism(n);
      if (mPar[3]) cfg.setDefaultBackupType(mPar[3] as 'BACKUPSET' | 'COMPRESSED BACKUPSET' | 'COPY');
    }
    // CHANNEL DEVICE TYPE … FORMAT '…' ──────────────────────────────
    const mChFmt = text.match(/^CHANNEL(?:\s+\d+)?\s+DEVICE TYPE (DISK|SBT).*\bFORMAT\s+'([^']+)'/i);
    if (mChFmt) delta = cfg.setChannelFormat(mChFmt[2]);
    // CONFIGURE CHANNEL <n> DEVICE TYPE … (no FORMAT) — accepted no-op
    // so MAXOPENFILES / RATE / MAXPIECESIZE-only forms don't 01009.
    if (!delta && /^CHANNEL(?:\s+\d+)?\s+DEVICE TYPE (DISK|SBT)\b/i.test(text)) {
      delta = { key: 'channelOpts', oldValue: '<unset>', newValue: text };
    }
    // BACKUP COPIES ────────────────────────────────────────────────
    const mDfC = upper.match(/^DATAFILE BACKUP COPIES FOR DEVICE TYPE (DISK|SBT) TO (\d+)$/);
    if (mDfC) delta = cfg.setDatafileBackupCopies(parseInt(mDfC[2], 10));
    const mArC = upper.match(/^ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE (DISK|SBT) TO (\d+)$/);
    if (mArC) delta = cfg.setArchivelogBackupCopies(parseInt(mArC[2], 10));
    // ARCHIVELOG DELETION POLICY ────────────────────────────────────
    if (upper === 'ARCHIVELOG DELETION POLICY TO NONE')
      delta = cfg.setArchivelogDeletionPolicy('NONE');
    if (upper === 'ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY')
      delta = cfg.setArchivelogDeletionPolicy('APPLIED_ON_ALL_STANDBY');
    const mArDP = upper.match(/^ARCHIVELOG DELETION POLICY TO BACKED UP (\d+) TIMES TO DEVICE TYPE (DISK|SBT)$/);
    if (mArDP) delta = cfg.setArchivelogDeletionPolicy('BACKED_UP');
    // ENCRYPTION ALGORITHM ──────────────────────────────────────────
    const mEncAlg = upper.match(/^ENCRYPTION ALGORITHM '(AES128|AES192|AES256)'$/);
    if (mEncAlg) delta = cfg.setEncryptionAlgorithm(mEncAlg[1] as 'AES128' | 'AES192' | 'AES256');
    // DEFAULT DEVICE TYPE ───────────────────────────────────────────
    if (upper === 'DEFAULT DEVICE TYPE TO DISK') delta = cfg.setDefaultDeviceType('DISK');
    if (upper === 'DEFAULT DEVICE TYPE TO SBT')  delta = cfg.setDefaultDeviceType('SBT');
    // BACKUP OPTIMIZATION ───────────────────────────────────────────
    if (upper === 'BACKUP OPTIMIZATION ON')  delta = cfg.setBackupOptimization(true);
    if (upper === 'BACKUP OPTIMIZATION OFF') delta = cfg.setBackupOptimization(false);
    // MAXSETSIZE ────────────────────────────────────────────────────
    const mMax = upper.match(/^MAXSETSIZE TO (UNLIMITED|\d+[KMGT]?)$/);
    if (mMax) delta = cfg.setMaxSetSize(mMax[1]);
    // COMPRESSION ALGORITHM ─────────────────────────────────────────
    const mComp = upper.match(/^COMPRESSION ALGORITHM '(BASIC|LOW|MEDIUM|HIGH)'$/);
    if (mComp) delta = cfg.setCompressionAlgorithm(mComp[1] as 'BASIC' | 'LOW' | 'MEDIUM' | 'HIGH');
    // ENCRYPTION FOR DATABASE ───────────────────────────────────────
    if (upper === 'ENCRYPTION FOR DATABASE ON')  delta = cfg.setEncryptionForDatabase(true);
    if (upper === 'ENCRYPTION FOR DATABASE OFF') delta = cfg.setEncryptionForDatabase(false);

    if (!delta) {
      return err({ code: 'RMAN_01009', message: `syntax error: unrecognized CONFIGURE clause: ${text}` });
    }

    cmdCtx.bus.emit({
      type: 'CONFIG_CHANGED', key: delta.key,
      oldValue: delta.oldValue, newValue: delta.newValue,
    });
    return ok(['new RMAN configuration parameters are successfully stored']);
  }
}
