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
import { parseControlFileImage } from '@/database/oracle/storage/ControlFileImage';

export type RestoreSystemTarget = 'CONTROLFILE_AUTOBACKUP' | 'CONTROLFILE_FROM' | 'SPFILE_AUTOBACKUP' | 'SPFILE_TO';

function findAutobackupOnDisk(cmdCtx: RmanCommandContext): string {
  const { ctx } = cmdCtx;
  const dest = ctx.getSpfileParam('db_recovery_file_dest');
  if (!dest || !ctx.vfs.listFilesRecursively) return '';
  const root = `${dest.replace(/\/+$/, '')}/${ctx.dbName.toUpperCase()}/autobackup`;
  const candidates = ctx.vfs.listFilesRecursively(root).filter(p => p.endsWith('.bkp'));
  return candidates.sort().reverse()[0] ?? '';
}

function catalogAutobackup(cmdCtx: RmanCommandContext): string {
  const snap = cmdCtx.catalog.listAll();
  if (snap.ok === false) return '';
  const set = snap.value.sets.find(
    s => s.type === 'CONTROLFILE' && s.tag.label.toUpperCase() === 'AUTOBACKUP',
  );
  const path = set?.pieces[0]?.path ?? '';
  return path && cmdCtx.ctx.vfs.fileExists(path) ? path : '';
}

function writeControlFilesFrom(
  cmdCtx: RmanCommandContext,
  piecePath: string,
): Result<void, RmanError> {
  const read = cmdCtx.ctx.vfs.readFile(piecePath);
  if (read.ok === false) return read;
  const image = parseControlFileImage(new TextDecoder().decode(read.value));
  if (!image) {
    return err({
      code: 'RMAN_06172',
      message: `piece ${piecePath} is not a valid copy of the controlfile`,
    });
  }
  const restorer = cmdCtx.engine as unknown as {
    restoreControlFilesFromImage?(img: typeof image): number;
  };
  restorer.restoreControlFilesFromImage?.(image);
  return ok(undefined);
}

export class RestoreSystemCommand implements IRmanCommand<string[]> {
  readonly name = 'RESTORE SYSTEM';
  constructor(private readonly target: RestoreSystemTarget) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const { ctx, catalog, engine } = cmdCtx;
    const inst = ctx.getInstanceState?.();
    // RESTORE CONTROLFILE / SPFILE require NOMOUNT or MOUNT, NOT OPEN.
    if (inst === 'OPEN') {
      return err({
        code: 'RMAN_06403',
        message: 'database must be NOMOUNT or MOUNT to restore the control file',
      });
    }

    let autobackupPath = '';
    if (this.target === 'CONTROLFILE_AUTOBACKUP' || this.target === 'SPFILE_AUTOBACKUP') {
      autobackupPath = findAutobackupOnDisk(cmdCtx) || catalogAutobackup(cmdCtx);
      if (!autobackupPath) {
        return err({
          code: 'RMAN_06172',
          message: 'no autobackup found or specified handle is not a valid copy of the controlfile',
        });
      }
    }

    if (this.target === 'CONTROLFILE_AUTOBACKUP') {
      const written = writeControlFilesFrom(cmdCtx, autobackupPath);
      if (written.ok === false) return written;
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
      const written = writeControlFilesFrom(cmdCtx, path);
      if (written.ok === false) return written;
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
