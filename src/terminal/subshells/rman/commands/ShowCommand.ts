/**
 * ShowCommand — SHOW ALL. Synchronous render of session configuration.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { snapshotControlfilePath } from '../core/snapshotControlfile';

export type ShowScope =
  | 'ALL' | 'RETENTION_POLICY' | 'DEFAULT_DEVICE_TYPE'
  | 'CONTROLFILE_AUTOBACKUP' | 'CONTROLFILE_AUTOBACKUP_FORMAT' | 'CHANNEL'
  | 'BACKUP_OPTIMIZATION' | 'DEVICE_TYPE' | 'DATAFILE_BACKUP_COPIES' | 'ARCHIVELOG_BACKUP_COPIES'
  | 'MAXSETSIZE' | 'ENCRYPTION_FOR_DATABASE' | 'ENCRYPTION_ALGORITHM' | 'COMPRESSION_ALGORITHM'
  | 'EXCLUDE' | 'ARCHIVELOG_DELETION_POLICY' | 'SNAPSHOT_CONTROLFILE';

type ConfiguredScope = Exclude<ShowScope, 'ALL' | 'CHANNEL'>;

interface ConfigurationLine {
  readonly scope: ConfiguredScope;
  readonly text: string;
}

function configurationLines(cmdCtx: RmanCommandContext): ConfigurationLine[] {
  const { policy, config } = cmdCtx;
  const c = config?.snapshot();
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
  const arDelPolRaw = c?.archivelogDeletionPolicy ?? 'NONE';
  const arDelPol    = arDelPolRaw === 'APPLIED_ON_ALL_STANDBY' ? 'APPLIED ON ALL STANDBY'
                   :  arDelPolRaw === 'BACKED_UP'             ? 'BACKED UP'
                   :                                            'NONE';
  const excluded = c?.excludedTablespaces;
  const excludedLines = excluded && excluded.size > 0
    ? [...excluded].sort().map(ts => `CONFIGURE EXCLUDE FOR TABLESPACE ${ts};`)
    : ['CONFIGURE EXCLUDE FOR TABLESPACE TEMP; # default, cleared if explicit'];

  return [
    { scope: 'RETENTION_POLICY', text: `CONFIGURE RETENTION POLICY TO ${retention};` },
    { scope: 'BACKUP_OPTIMIZATION', text: `CONFIGURE BACKUP OPTIMIZATION ${optim};` },
    { scope: 'DEFAULT_DEVICE_TYPE', text: `CONFIGURE DEFAULT DEVICE TYPE TO ${defDev};` },
    { scope: 'CONTROLFILE_AUTOBACKUP', text: `CONFIGURE CONTROLFILE AUTOBACKUP ${cfAuto};` },
    { scope: 'CONTROLFILE_AUTOBACKUP_FORMAT', text: `CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE ${defDev} TO '${cfFormat}';` },
    { scope: 'DEVICE_TYPE', text: `CONFIGURE DEVICE TYPE ${defDev} PARALLELISM ${parallel} BACKUP TYPE TO BACKUPSET;` },
    { scope: 'DATAFILE_BACKUP_COPIES', text: `CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE ${defDev} TO ${dfCopies};` },
    { scope: 'ARCHIVELOG_BACKUP_COPIES', text: `CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE ${defDev} TO ${arCopies};` },
    { scope: 'MAXSETSIZE', text: `CONFIGURE MAXSETSIZE TO ${maxSize};` },
    { scope: 'ENCRYPTION_FOR_DATABASE', text: `CONFIGURE ENCRYPTION FOR DATABASE ${encDb};` },
    { scope: 'ENCRYPTION_ALGORITHM', text: `CONFIGURE ENCRYPTION ALGORITHM '${encAlg}';` },
    { scope: 'COMPRESSION_ALGORITHM', text: `CONFIGURE COMPRESSION ALGORITHM '${compAlg}' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;` },
    ...excludedLines.map((text): ConfigurationLine => ({ scope: 'EXCLUDE', text })),
    { scope: 'ARCHIVELOG_DELETION_POLICY', text: `CONFIGURE ARCHIVELOG DELETION POLICY TO ${arDelPol};` },
    {
      scope: 'SNAPSHOT_CONTROLFILE',
      text: `CONFIGURE SNAPSHOT CONTROLFILE NAME TO '${snapshotControlfilePath(c?.snapshotControlfile, cmdCtx.ctx.dbName)}';`
        + (c?.snapshotControlfile === undefined ? ' # default' : ''),
    },
  ];
}

export class ShowCommand implements IRmanCommand<string[]> {
  readonly name = 'SHOW';

  constructor(private readonly scope: ShowScope = 'ALL') {}

  execute(_args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const { ctx, pool, userChannels } = cmdCtx;

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

    const entries = configurationLines(cmdCtx);
    if (this.scope !== 'ALL') {
      return ok(['', ...entries.filter(entry => entry.scope === this.scope).map(entry => entry.text), '']);
    }
    return ok([
      '',
      `RMAN configuration parameters for database with db_unique_name ${ctx.dbName} are:`,
      ...entries.map(entry => entry.text),
      '',
    ]);
  }
}
