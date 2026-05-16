/**
 * ConnectCommand — CONNECT TARGET / synthetic; emits CONNECTED.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ConnectCommand implements IRmanCommand<string[]> {
  readonly name = 'CONNECT';

  execute(_args: string[], { bus, ctx }: RmanCommandContext): Result<string[], RmanError> {
    bus.emit({
      type: 'CONNECTED',
      dbId: String(ctx.dbId.value), dbName: ctx.dbName, connectedAt: Date.now(),
    });
    return ok([`connected to target database: ${ctx.dbName} (DBID=${ctx.dbId.value})`]);
  }
}
