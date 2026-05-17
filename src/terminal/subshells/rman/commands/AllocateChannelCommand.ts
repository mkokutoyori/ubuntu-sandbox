/**
 * AllocateChannelCommand — ALLOCATE CHANNEL <alias> DEVICE TYPE DISK|SBT.
 *
 * Reaches into the session's channel pool directly. The newly allocated
 * handle is renamed to the user-supplied alias (the pool emits a
 * CHANNEL_ALLOCATED event with the alias as channelId) and stored on
 * the cmdCtx.userChannels map so RELEASE CHANNEL can find it.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class AllocateChannelCommand implements IRmanCommand<string[]> {
  readonly name = 'ALLOCATE CHANNEL';

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const alias = args[0];
    const deviceType = (args[1] ?? 'DISK').toUpperCase() as 'DISK' | 'SBT';
    if (!alias) return err({ code: 'RMAN_00558', message: 'ALLOCATE CHANNEL requires an alias' });
    if (!cmdCtx.pool || !cmdCtx.userChannels) {
      return err({ code: 'RMAN_00558', message: 'ALLOCATE CHANNEL requires a session pool' });
    }
    const r = cmdCtx.pool.allocate(alias);
    if (!r.ok) return r as Result<string[], RmanError>;
    const handle = r.value;
    cmdCtx.userChannels.set(alias, handle);
    return ok([
      `allocated channel: ${alias}`,
      `channel ${alias}: SID=${handle.sid} device type=${deviceType}`,
    ]);
  }
}
