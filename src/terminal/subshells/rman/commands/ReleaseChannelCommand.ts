/**
 * ReleaseChannelCommand — RELEASE CHANNEL <alias>.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ReleaseChannelCommand implements IRmanCommand<string[]> {
  readonly name = 'RELEASE CHANNEL';

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const alias = args[0];
    if (!alias) return err({ code: 'RMAN_00558', message: 'RELEASE CHANNEL requires an alias' });
    if (!cmdCtx.pool || !cmdCtx.userChannels) {
      return err({ code: 'RMAN_00558', message: 'RELEASE CHANNEL requires a session pool' });
    }
    const h = cmdCtx.userChannels.get(alias);
    if (!h) {
      // Idempotent: still emit a release event so subscribers can react.
      cmdCtx.bus.emit({ type: 'CHANNEL_RELEASED', channelId: alias });
      return ok([`released channel: ${alias}`]);
    }
    cmdCtx.pool.release(h);
    // Re-publish with the user alias for visibility.
    cmdCtx.bus.emit({ type: 'CHANNEL_RELEASED', channelId: alias });
    cmdCtx.userChannels.delete(alias);
    return ok([`released channel: ${alias}`]);
  }
}
