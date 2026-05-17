/**
 * RestoreCommand — RESTORE granularity.
 *
 *   RESTORE DATABASE [FROM TAG '<x>'] [PREVIEW | VALIDATE]
 *   RESTORE TABLESPACE <name> [FROM TAG '<x>'] [PREVIEW | VALIDATE]
 *   RESTORE DATAFILE  <n>    [FROM TAG '<x>'] [PREVIEW | VALIDATE]
 *
 * Args:
 *   args[0] = scope keyword (DATABASE | TABLESPACE | DATAFILE)
 *   args[1] = scope argument (tablespace name or datafile number) — optional
 *   args[2] = optional trailing clauses (FROM TAG, PREVIEW, VALIDATE)
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class RestoreCommand implements IRmanCommand<void> {
  readonly name = 'RESTORE';

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const scope = (args[0] ?? 'DATABASE').toUpperCase();
    const trailing = (scope === 'DATABASE' ? args[1] : args[2]) ?? '';
    const tagMatch = trailing.match(/\bFROM\s+TAG\s+'([^']+)'/i);
    const preview  = /\bPREVIEW\b/i.test(trailing);
    const validate = /\bVALIDATE\b/i.test(trailing);
    const opts = {
      tag: tagMatch?.[1].toUpperCase(),
      preview, validate,
    };

    if (scope === 'DATABASE') {
      return engine.run(JobBuilder.restoreDatabase(opts));
    }
    if (scope === 'TABLESPACE') {
      const ts = (args[1] ?? '').toUpperCase();
      if (!ts) return err({ code: 'RMAN_01009', message: 'syntax error: RESTORE TABLESPACE requires a name' });
      return engine.run(JobBuilder.restoreTablespace(ts, opts));
    }
    if (scope === 'DATAFILE') {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) {
        return err({ code: 'RMAN_01009', message: 'syntax error: RESTORE DATAFILE requires a file number' });
      }
      return engine.run(JobBuilder.restoreDatafile(n, opts));
    }
    return err({ code: 'RMAN_01009', message: `syntax error: unsupported RESTORE scope ${scope}` });
  }
}
