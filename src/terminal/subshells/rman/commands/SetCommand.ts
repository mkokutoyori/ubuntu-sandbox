/**
 * SetCommand — Oracle's "SET" verb inside a RUN block.
 *
 * Modes:
 *   - 'NEWNAME'     SET NEWNAME FOR DATAFILE <n> TO '<path>'
 *   - 'UNTIL_TIME'  SET UNTIL TIME '<date>'
 *   - 'UNTIL_SCN'   SET UNTIL SCN  <n>
 *
 * The first stores rename targets in cmdCtx.setNewname; the two UNTIL
 * forms write into cmdCtx.setUntil so later RESTORE/RECOVER calls inside
 * the same RUN block inherit the PITR cutoff without repeating it.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export type SetMode = 'NEWNAME' | 'UNTIL_TIME' | 'UNTIL_SCN';

export class SetCommand implements IRmanCommand<string[]> {
  readonly name = 'SET';
  constructor(private readonly mode: SetMode = 'NEWNAME') {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (this.mode === 'UNTIL_TIME') {
      const raw = (args[0] ?? '').replace(/^'|'$/g, '').trim();
      if (!raw) return err({ code: 'RMAN_01009', message: 'SET UNTIL TIME requires a quoted date' });
      const u = cmdCtx.setUntil;
      if (u) { u.untilTime = raw; u.untilScn = undefined; }
      return ok([`executing command: SET until clause`]);
    }
    if (this.mode === 'UNTIL_SCN') {
      const n = Number(args[0]);
      if (!Number.isFinite(n)) return err({ code: 'RMAN_01009', message: 'SET UNTIL SCN requires a number' });
      const u = cmdCtx.setUntil;
      if (u) { u.untilScn = n; u.untilTime = undefined; }
      return ok([`executing command: SET until clause`]);
    }
    // 'NEWNAME'
    const n = Number(args[0]);
    const target = args[1] ?? '';
    if (!Number.isFinite(n) || !target) {
      return err({ code: 'RMAN_01009', message: `SET NEWNAME requires datafile number + path` });
    }
    cmdCtx.setNewname?.set(n, target.replace(/^'|'$/g, ''));
    return ok([`new name for datafile ${n}: ${target}`]);
  }
}
