/**
 * ChangeCommand — mutates catalog rows without writing/reading the file.
 *
 *   CHANGE BACKUPSET <n> UNAVAILABLE
 *   CHANGE BACKUPSET <n> AVAILABLE
 *   CHANGE BACKUP TAG '<x>' DELETE
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export type ChangeAction = 'AVAILABLE' | 'UNAVAILABLE' | 'DELETE_BY_TAG';

export class ChangeCommand implements IRmanCommand<string[]> {
  readonly name = 'CHANGE';
  constructor(private readonly action: ChangeAction) {}

  execute(args: string[], { catalog, ctx }: RmanCommandContext): Result<string[], RmanError> {
    if (this.action === 'DELETE_BY_TAG') {
      const tag = (args[0] ?? '').toUpperCase();
      if (!tag) return err({ code: 'RMAN_01009', message: 'CHANGE BACKUP TAG requires a tag' });
      const snap = catalog.listAll();
      if (!snap.ok) return snap;
      const matches = snap.value.sets.filter(s => s.tag.label.toUpperCase() === tag);
      if (matches.length === 0) {
        return err({ code: 'BACKUP_KEY_NOT_FOUND', message: `no backup set with tag ${tag}`, key: tag });
      }
      for (const s of matches) {
        for (const p of s.pieces) ctx.vfs.deleteFile(p.path);
        catalog.deleteBackupSet(s.bsKey);
      }
      return ok([`deleted ${matches.length} backup set(s) with tag ${tag}`]);
    }

    const n = Number(args[0]);
    if (!Number.isFinite(n)) {
      return err({ code: 'RMAN_01009', message: 'CHANGE BACKUPSET requires a numeric key' });
    }
    const r = catalog.setSetStatus(n, this.action);
    if (!r.ok) return r as Result<string[], RmanError>;
    return ok([`changed backup set ${n} to ${this.action}`]);
  }
}
