/**
 * DeleteCommand — DELETE [NOPROMPT] (EXPIRED | OBSOLETE | BACKUP TAG '<x>' |
 *                                    BACKUPSET <n> | ARCHIVELOG ALL)
 *
 * Modes:
 *   - 'EXPIRED'    : catalog-level expired pieces
 *   - 'OBSOLETE'   : retention-policy obsolete sets
 *   - 'BY_TAG'     : remove every set with matching tag (args[0])
 *   - 'BY_BSKEY'   : remove the single set whose bsKey === args[0]
 *   - 'ARCHIVELOG' : remove every archived log via VFS (no-op when empty)
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export type DeleteMode = 'EXPIRED' | 'OBSOLETE' | 'BY_TAG' | 'BY_BSKEY' | 'ARCHIVELOG';

export class DeleteCommand implements IRmanCommand<void> {
  readonly name = 'DELETE';
  constructor(private readonly mode: DeleteMode) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<void, RmanError> {
    const { catalog, ctx, policy, engine } = cmdCtx;

    switch (this.mode) {
      case 'EXPIRED':
        return engine.run(JobBuilder.deleteExpired());

      case 'OBSOLETE': {
        const snap = catalog.listAll();
        if (!snap.ok) return snap;
        const obsolete = policy.findObsolete(snap.value.sets).map(s => s.bsKey);
        return engine.run(JobBuilder.deleteObsolete(obsolete));
      }

      case 'BY_TAG': {
        const tag = (args[0] ?? '').toUpperCase();
        if (!tag) return err({ code: 'RMAN_01009', message: "DELETE BACKUP TAG requires a tag" });
        const snap = catalog.listAll();
        if (!snap.ok) return snap;
        const matching = snap.value.sets.filter(s => s.tag.label.toUpperCase() === tag).map(s => s.bsKey);
        return engine.run(JobBuilder.deleteObsolete(matching));
      }

      case 'BY_BSKEY': {
        const n = Number(args[0]);
        if (!Number.isFinite(n)) {
          return err({ code: 'RMAN_01009', message: 'DELETE BACKUPSET requires a numeric key' });
        }
        return engine.run(JobBuilder.deleteObsolete([n]));
      }

      case 'ARCHIVELOG': {
        const paths = ctx.getArchivelogPaths?.() ?? [];
        for (const p of paths) ctx.vfs.deleteFile(p);
        return ok(undefined);
      }
    }
  }
}
