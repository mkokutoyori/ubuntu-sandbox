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
import { RedundancyPolicy } from '../policy/RedundancyPolicy';
import { RecoveryWindowPolicy } from '../policy/RecoveryWindowPolicy';
import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import { completedWithin, parseCompletedClause } from '../core/completedTime';
import { rmanNowMs } from '../core/pureUtils';

const NO_MATCHING_BACKUP = 'specification does not match any backup in the repository';
const NO_OBSOLETE_BACKUP = 'no obsolete backups found';
const MS_PER_DAY = 86_400_000;

export type DeleteMode = 'EXPIRED' | 'OBSOLETE' | 'BY_TAG' | 'BY_BSKEY' | 'ARCHIVELOG' | 'ALL' | 'COMPLETED';

export class DeleteCommand implements IRmanCommand<string[] | void> {
  readonly name = 'DELETE';
  constructor(private readonly mode: DeleteMode) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[] | void, RmanError> {
    const { catalog, ctx, policy, engine } = cmdCtx;

    switch (this.mode) {
      case 'EXPIRED':
        return engine.run(JobBuilder.deleteExpired());

      case 'OBSOLETE': {
        // Optional policy suffix: REDUNDANCY n / RECOVERY WINDOW OF n DAYS
        const suffix = (args[0] ?? '').trim();
        const activePolicy: IRetentionPolicy = (() => {
          const r = suffix.match(/^REDUNDANCY\s+(\d+)$/i);
          if (r) return new RedundancyPolicy(parseInt(r[1], 10));
          const w = suffix.match(/^RECOVERY\s+WINDOW\s+OF\s+(\d+)\s+DAYS?$/i);
          if (w) return new RecoveryWindowPolicy(parseInt(w[1], 10));
          return policy;
        })();
        const snap = catalog.listAll();
        if (snap.ok === false) return snap;
        const obsolete = activePolicy.findObsolete(snap.value.sets, rmanNowMs(ctx)).map(s => s.bsKey);
        return engine.run(JobBuilder.deleteObsolete(obsolete, NO_OBSOLETE_BACKUP));
      }

      case 'BY_TAG': {
        const tag = (args[0] ?? '').toUpperCase();
        if (!tag) return err({ code: 'RMAN_01009', message: "DELETE BACKUP TAG requires a tag" });
        const snap = catalog.listAll();
        if (snap.ok === false) return snap;
        const matching = snap.value.sets.filter(s => s.tag.label.toUpperCase() === tag).map(s => s.bsKey);
        return engine.run(JobBuilder.deleteObsolete(matching, NO_MATCHING_BACKUP));
      }

      case 'BY_BSKEY': {
        const keys = (args[0] ?? '').split(',').map(part => Number(part.trim()));
        if (keys.length === 0 || keys.some(key => !Number.isInteger(key))) {
          return err({ code: 'RMAN_01009', message: 'DELETE BACKUPSET requires a numeric key' });
        }
        return engine.run(JobBuilder.deleteObsolete(keys, NO_MATCHING_BACKUP));
      }

      case 'ALL': {
        const snap = catalog.listAll();
        if (snap.ok === false) return snap;
        return engine.run(JobBuilder.deleteObsolete(snap.value.sets.map(s => s.bsKey), NO_MATCHING_BACKUP));
      }

      case 'COMPLETED': {
        const window = parseCompletedClause(args[0] ?? '', rmanNowMs(ctx));
        if (window === null) {
          return err({ code: 'RMAN_01009', message: `DELETE BACKUP ${args[0] ?? ''}: invalid date` });
        }
        const snap = catalog.listAll();
        if (snap.ok === false) return snap;
        const matching = snap.value.sets.filter(s => completedWithin(window, s.completionTime)).map(s => s.bsKey);
        return engine.run(JobBuilder.deleteObsolete(matching, NO_MATCHING_BACKUP));
      }

      case 'ARCHIVELOG': {
        const paths = ctx.getArchivelogPaths?.() ?? [];
        for (const p of paths) {
          ctx.vfs.deleteFile(p);
          ctx.recordArchivedLogDeleted?.(p);
        }
        if (paths.length === 0) {
          return ok(['specification matches no archived logs in the recovery catalog']);
        }
        return ok([
          'allocated channel: ORA_DISK_1',
          `channel ORA_DISK_1: deleting archived log(s) — ${paths.length} file(s)`,
          ...paths.map(p => `archived log file name=${p}`),
          `Deleted ${paths.length} objects`,
        ]);
      }
    }
  }
}
