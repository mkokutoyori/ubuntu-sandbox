/**
 * RecoverCommand — RECOVER granularity.
 *
 *   RECOVER DATABASE [UNTIL (SCN <n> | TIME '<date>' | CANCEL)]
 *   RECOVER TABLESPACE <name>
 *   RECOVER DATAFILE  <n>
 *
 * Dispatcher captures:
 *   args[0] = scope (DATABASE | TABLESPACE | DATAFILE)
 *   args[1] = scope arg (name or fileNo) — only for TABLESPACE/DATAFILE
 *   args[N] = trailing text (UNTIL ...)
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';
import { Scn } from '../values/Scn';

interface RecoverOpts {
  untilScn?: number;
  untilTime?: string;
  untilCancel?: boolean;
  tablespace?: string;
  fileNo?: number;
}

export class RecoverCommand implements IRmanCommand<void> {
  readonly name = 'RECOVER';

  execute(args: string[], { engine, setUntil }: RmanCommandContext): Result<void, RmanError> {
    const scope = (args[0] ?? 'DATABASE').toUpperCase();
    const trailing = (scope === 'DATABASE' ? args[1] : args[2]) ?? '';
    const opts: RecoverOpts = {};
    // Inherit any SET UNTIL TIME/SCN that ran earlier in the same RUN block.
    if (setUntil?.untilTime) opts.untilTime = setUntil.untilTime;
    if (setUntil?.untilScn !== undefined) opts.untilScn = setUntil.untilScn;

    if (scope === 'TABLESPACE') {
      const ts = (args[1] ?? '').toUpperCase();
      if (!ts) return err({ code: 'RMAN_01009', message: 'syntax error: RECOVER TABLESPACE requires a name' });
      opts.tablespace = ts;
    } else if (scope === 'DATAFILE') {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) {
        return err({ code: 'RMAN_01009', message: 'syntax error: RECOVER DATAFILE requires a file number' });
      }
      opts.fileNo = n;
    } else if (scope !== 'DATABASE') {
      return err({ code: 'RMAN_01009', message: `syntax error: unsupported RECOVER scope ${scope}` });
    }

    if (trailing.trim()) {
      const scn = trailing.match(/^UNTIL\s+SCN\s+(\S+)/i);
      if (scn) {
        const v = Scn.of(scn[1]);
        if (!v.ok) return v;
        opts.untilScn = v.value.value;
      } else {
        const time = trailing.match(/^UNTIL\s+TIME\s+'([^']+)'/i);
        if (time) opts.untilTime = time[1];
        else if (/^UNTIL\s+CANCEL/i.test(trailing)) opts.untilCancel = true;
        else if (scope === 'DATABASE') {
          return err({ code: 'RMAN_01009', message: `syntax error: unsupported RECOVER clause: ${trailing}` });
        }
      }
    }

    return engine.run(JobBuilder.recoverDatabase(opts));
  }
}
