/**
 * ShowCommand — SHOW ALL. Synchronous render of session configuration.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export type ShowScope =
  | 'ALL' | 'RETENTION_POLICY' | 'DEFAULT_DEVICE_TYPE'
  | 'CONTROLFILE_AUTOBACKUP' | 'CHANNEL';

export class ShowCommand implements IRmanCommand<string[]> {
  readonly name = 'SHOW';

  constructor(private readonly scope: ShowScope = 'ALL') {}

  execute(_args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const { policy, ctx, config, pool, userChannels } = cmdCtx;
    const c = config?.snapshot();

    if (this.scope === 'RETENTION_POLICY') {
      const retention = c?.retentionPolicy.describe() ?? policy.describe();
      return ok(['', `CONFIGURE RETENTION POLICY TO ${retention};`, '']);
    }
    if (this.scope === 'DEFAULT_DEVICE_TYPE') {
      const defDev = c?.defaultDeviceType ?? 'DISK';
      return ok(['', `CONFIGURE DEFAULT DEVICE TYPE TO ${defDev};`, '']);
    }
    if (this.scope === 'CONTROLFILE_AUTOBACKUP') {
      const cfAuto = c?.controlfileAutobackup === false ? 'OFF' : 'ON';
      return ok(['', `CONFIGURE CONTROLFILE AUTOBACKUP ${cfAuto};`, '']);
    }
    if (this.scope === 'CHANNEL') {
      const lines: string[] = [''];
      const cfgs = pool?.getConfigs() ?? [];
      for (const cfg of cfgs) {
        lines.push(
          `CONFIGURE CHANNEL ${cfg.id} DEVICE TYPE ${cfg.deviceType} ` +
          `PARALLELISM ${cfg.parallelism} MAXOPENFILES ${cfg.maxOpenFiles};`,
        );
      }
      if (userChannels && userChannels.size > 0) {
        for (const [alias, h] of userChannels.entries()) {
          lines.push(`allocated channel: ${alias} (SID=${h.sid}, type=${h.deviceType})`);
        }
      }
      lines.push('');
      return ok(lines);
    }

    // Pull from live config when available; otherwise fall back to the
    // legacy hardcoded defaults the design doc flagged as DEF-RMAN-02.
    const retention   = c?.retentionPolicy.describe() ?? policy.describe();
    const optim       = c?.backupOptimization ? 'ON' : 'OFF';
    const defDev      = c?.defaultDeviceType ?? 'DISK';
    const cfAuto      = c?.controlfileAutobackup === false ? 'OFF' : 'ON';
    const cfFormat    = c?.controlfileAutobackupFormat ?? '%F';
    const parallel    = c?.deviceParallelism ?? 1;
    const dfCopies    = c?.datafileBackupCopies ?? 1;
    const arCopies    = c?.archivelogBackupCopies ?? 1;
    const maxSize     = c?.maxSetSize ?? 'UNLIMITED';
    const encDb       = c?.encryptionForDatabase ? 'ON' : 'OFF';
    const encAlg      = c?.encryptionAlgorithm ?? 'AES128';
    const compAlg     = c?.compressionAlgorithm ?? 'BASIC';
    const arDelPol    = c?.archivelogDeletionPolicy ?? 'NONE';

    return ok([
      '',
      `RMAN configuration parameters for database with db_unique_name ${ctx.dbName} are:`,
      `CONFIGURE RETENTION POLICY TO ${retention};`,
      `CONFIGURE BACKUP OPTIMIZATION ${optim};`,
      `CONFIGURE DEFAULT DEVICE TYPE TO ${defDev};`,
      `CONFIGURE CONTROLFILE AUTOBACKUP ${cfAuto};`,
      `CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE ${defDev} TO '${cfFormat}';`,
      `CONFIGURE DEVICE TYPE ${defDev} PARALLELISM ${parallel} BACKUP TYPE TO BACKUPSET;`,
      `CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE ${defDev} TO ${dfCopies};`,
      `CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE ${defDev} TO ${arCopies};`,
      `CONFIGURE MAXSETSIZE TO ${maxSize};`,
      `CONFIGURE ENCRYPTION FOR DATABASE ${encDb};`,
      `CONFIGURE ENCRYPTION ALGORITHM '${encAlg}';`,
      `CONFIGURE COMPRESSION ALGORITHM '${compAlg}' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;`,
      `CONFIGURE ARCHIVELOG DELETION POLICY TO ${arDelPol};`,
      '',
    ]);
  }
}
