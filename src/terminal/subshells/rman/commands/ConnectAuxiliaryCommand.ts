/**
 * ConnectAuxiliaryCommand — `CONNECT AUXILIARY [target]`.
 *
 * In a real RMAN session this opens a second TNS connection to the
 * auxiliary instance used by DUPLICATE. The simulator has no aux
 * process, so the command is accepted as a no-op and emits the
 * canonical "connected" line.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ConnectAuxiliaryCommand implements IRmanCommand<string[]> {
  readonly name = 'CONNECT AUXILIARY';

  execute(_args: string[], { ctx }: RmanCommandContext): Result<string[], RmanError> {
    return ok([`connected to auxiliary database: ${ctx.dbName} (not started)`]);
  }
}
