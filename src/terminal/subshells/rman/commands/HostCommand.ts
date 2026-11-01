import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class HostCommand implements IRmanCommand<string[]> {
  readonly name = 'HOST';

  execute(args: string[], { ctx, bus }: RmanCommandContext): Result<string[], RmanError> {
    const command = (args[0] ?? '').trim();
    if (command === '') {
      bus.emit({ type: 'HOST_SHELL_REQUESTED' });
      return ok([]);
    }
    if (ctx.runHostCommand === undefined) {
      return err({ code: 'RMAN_01009', message: 'HOST is not available on this host' });
    }
    const output = ctx.runHostCommand(command);
    return ok([...(output === '' ? [] : output.split('\n')), 'host command complete']);
  }
}
