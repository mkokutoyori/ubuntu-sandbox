/**
 * SetCommand — Oracle's "SET" verb inside a RUN block.
 *
 * Currently supported:
 *   SET NEWNAME FOR DATAFILE <n> TO '<path>'
 *
 * Stores the rename target in cmdCtx.setNewname (Map<fileNo, path>) so
 * later RESTORE/DUPLICATE commands inside the same RUN block can pick
 * the destination from the map.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class SetCommand implements IRmanCommand<string[]> {
  readonly name = 'SET';

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const n = Number(args[0]);
    const target = args[1] ?? '';
    if (!Number.isFinite(n) || !target) {
      return err({ code: 'RMAN_01009', message: `SET NEWNAME requires datafile number + path` });
    }
    cmdCtx.setNewname?.set(n, target.replace(/^'|'$/g, ''));
    return ok([`new name for datafile ${n}: ${target}`]);
  }
}
