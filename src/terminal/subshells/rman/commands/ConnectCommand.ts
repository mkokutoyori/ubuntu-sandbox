import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

const IDENTIFIER = /@(\S+)/;

export class ConnectCommand implements IRmanCommand<string[]> {
  readonly name = 'CONNECT';

  execute(args: string[], { bus, ctx }: RmanCommandContext): Result<string[], RmanError> {
    const identifier = IDENTIFIER.exec(args.join(' '))?.[1]?.replace(/;$/, '');
    if (identifier && ctx.connectTarget) {
      const outcome = ctx.connectTarget(identifier);
      if (outcome.ok === false) {
        return ok([
          'RMAN-00571: ===========================================================',
          'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
          'RMAN-00571: ===========================================================',
          `RMAN-04006: error from target database: ${outcome.error}`,
        ]);
      }
      bus.emit({
        type: 'CONNECTED',
        dbId: String(outcome.dbId), dbName: outcome.dbName, connectedAt: Date.now(),
      });
      return ok([`connected to target database: ${outcome.dbName} (DBID=${outcome.dbId})`]);
    }

    bus.emit({
      type: 'CONNECTED',
      dbId: String(ctx.dbId.value), dbName: ctx.dbName, connectedAt: Date.now(),
    });
    return ok([`connected to target database: ${ctx.dbName} (DBID=${ctx.dbId.value})`]);
  }
}
