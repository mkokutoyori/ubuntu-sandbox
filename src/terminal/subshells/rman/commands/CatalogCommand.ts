/**
 * CatalogCommand — `CATALOG DATAFILECOPY '<path>'` and
 *                   `CATALOG BACKUPPIECE  '<path>'`.
 *
 * Registers a pre-existing file (datafile copy or backup piece) with the
 * RMAN catalog without producing a new backup job. The file must exist
 * in the VFS, otherwise RMAN_06004 is returned. On success a new
 * BackupSet is appended and a CATALOG_UPDATED event fires (forwarded by
 * the InMemoryRmanCatalog).
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { BackupSetFactory } from '../catalog/BackupSetFactory';
import { Scn } from '../values/Scn';

export type CatalogKind = 'DATAFILECOPY' | 'BACKUPPIECE';

export class CatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'CATALOG';

  constructor(private readonly _kind: CatalogKind) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const raw = (args[0] ?? '').trim();
    const m = raw.match(/^'([^']+)'$/);
    if (!m) {
      return err({ code: 'RMAN_01009', message: `syntax error: CATALOG ${this._kind} expects a quoted path` });
    }
    const path = m[1];

    if (!cmdCtx.ctx.vfs.fileExists(path)) {
      return err({ code: 'RMAN_06004', message: `RMAN-06004: backup piece not found: ${path}` });
    }

    const ckp = Scn.of(1_892_354);
    const set = BackupSetFactory.createBackupSet({
      type:      this._kind === 'DATAFILECOPY' ? 'DATAFILECOPY' : 'FULL',
      level:     0,
      path,
      sizeBytes: 0,
      datafiles: this._kind === 'DATAFILECOPY' ? [Object.freeze({
        fileNo:  0,
        level:   0 as 0 | 1,
        ckpScn:  ckp.ok ? ckp.value : Scn.ZERO,
        ckpTime: Date.now(),
        path,
      })] : [],
    });
    const r = cmdCtx.catalog.recordBackupSet(set);
    if (!r.ok) return r as Result<string[], RmanError>;
    return ok([`cataloged ${this._kind === 'DATAFILECOPY' ? 'datafile copy' : 'backup piece'}: ${path}`]);
  }
}
