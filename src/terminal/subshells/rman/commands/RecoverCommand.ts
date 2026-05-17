/**
 * RecoverCommand — RECOVER DATABASE [UNTIL SCN <n> | UNTIL TIME '<date>']
 *
 * Args:
 *   args[0] = raw text after "RECOVER DATABASE" (may be empty)
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';
import { Scn } from '../values/Scn';

export class RecoverCommand implements IRmanCommand<void> {
  readonly name = 'RECOVER';

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const text = (args[0] ?? '').trim();
    if (!text) return engine.run(JobBuilder.recoverDatabase());

    const scn = text.match(/^UNTIL\s+SCN\s+(\S+)$/i);
    if (scn) {
      const v = Scn.of(scn[1]);
      if (!v.ok) return v;
      return engine.run(JobBuilder.recoverDatabase({ untilScn: v.value.value }));
    }
    const time = text.match(/^UNTIL\s+TIME\s+'([^']+)'$/i);
    if (time) return engine.run(JobBuilder.recoverDatabase({ untilTime: time[1] }));

    return err({ code: 'RMAN_01009', message: `syntax error: unsupported RECOVER clause: ${text}` });
  }
}
