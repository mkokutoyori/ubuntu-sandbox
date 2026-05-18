/**
 * RESTORE CONTROLFILE / SPFILE — recettes canoniques de DR.
 *
 *   RESTORE CONTROLFILE FROM AUTOBACKUP
 *   RESTORE CONTROLFILE FROM '<path>'
 *   RESTORE SPFILE FROM AUTOBACKUP
 *   RESTORE SPFILE TO '<path>'
 *
 * Pour restaurer le control file, l'instance doit être en NOMOUNT (pas
 * de control file → pas de chemin pour aller plus haut). On émet le
 * pipeline canonique JOB_STARTED / progress / JOB_COMPLETED pour qu'un
 * sub-shell le rende correctement.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export type RestoreSystemTarget = 'CONTROLFILE_AUTOBACKUP' | 'CONTROLFILE_FROM' | 'SPFILE_AUTOBACKUP' | 'SPFILE_TO';

export class RestoreSystemCommand implements IRmanCommand<string[]> {
  readonly name = 'RESTORE SYSTEM';
  constructor(private readonly target: RestoreSystemTarget) {}

  execute(args: string[], { ctx }: RmanCommandContext): Result<string[], RmanError> {
    const inst = ctx.getInstanceState?.();
    // RESTORE CONTROLFILE / SPFILE require NOMOUNT or MOUNT, NOT OPEN.
    if (inst === 'OPEN') {
      return err({
        code: 'RMAN_06403',
        message: 'database must be NOMOUNT or MOUNT to restore the control file',
      });
    }

    if (this.target === 'CONTROLFILE_AUTOBACKUP') {
      return ok([
        '',
        `Starting restore at ${new Date().toISOString()}`,
        'allocated channel: ORA_DISK_1',
        'channel ORA_DISK_1: SID=100 device type=DISK',
        '',
        'channel ORA_DISK_1: looking for AUTOBACKUP on day: ' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
        `channel ORA_DISK_1: AUTOBACKUP found: c-${ctx.dbId.value}-${new Date().toISOString().slice(0, 10)}-00`,
        `channel ORA_DISK_1: restoring control file from AUTOBACKUP c-${ctx.dbId.value}-...`,
        'channel ORA_DISK_1: control file restore from AUTOBACKUP complete',
        `output file name=${ctx.getControlFilePath?.() ?? '/u01/oradata/' + ctx.dbName + '/control01.ctl'}`,
        `Finished restore at ${new Date().toISOString()}`,
        '',
      ]);
    }
    if (this.target === 'CONTROLFILE_FROM') {
      const path = (args[0] ?? '').replace(/^'|'$/g, '');
      if (!path) return err({ code: 'RMAN_01009', message: 'RESTORE CONTROLFILE FROM requires a quoted path' });
      if (!ctx.vfs.fileExists(path)) {
        return err({ code: 'RMAN_06004', message: `backup piece ${path} not found` });
      }
      return ok([
        '',
        `Starting restore at ${new Date().toISOString()}`,
        'allocated channel: ORA_DISK_1',
        `channel ORA_DISK_1: restoring control file from '${path}'`,
        'channel ORA_DISK_1: control file restore complete',
        `Finished restore at ${new Date().toISOString()}`,
        '',
      ]);
    }
    if (this.target === 'SPFILE_AUTOBACKUP') {
      return ok([
        '',
        `Starting restore at ${new Date().toISOString()}`,
        'allocated channel: ORA_DISK_1',
        `channel ORA_DISK_1: looking for AUTOBACKUP on day: ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
        `channel ORA_DISK_1: AUTOBACKUP found: c-${ctx.dbId.value}-${new Date().toISOString().slice(0, 10)}-00`,
        'channel ORA_DISK_1: restoring SPFILE from AUTOBACKUP',
        'channel ORA_DISK_1: SPFILE restore complete',
        `Finished restore at ${new Date().toISOString()}`,
        '',
      ]);
    }
    if (this.target === 'SPFILE_TO') {
      const path = (args[0] ?? '').replace(/^'|'$/g, '');
      return ok([
        '',
        `Starting restore at ${new Date().toISOString()}`,
        `channel ORA_DISK_1: SPFILE restored to ${path || '/u01/oradata/spfile.ora'}`,
        `Finished restore at ${new Date().toISOString()}`,
        '',
      ]);
    }
    return ok([]);
  }
}
