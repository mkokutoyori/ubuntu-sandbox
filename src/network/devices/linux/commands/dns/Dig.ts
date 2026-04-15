/**
 * `dig` — Linux DNS lookup utility.
 *
 * Thin wrapper around `executeDig` from `LinuxDnsService`. Reads the
 * configured resolver from `/etc/resolv.conf` via `ctx.executor`.
 *
 * See `linux_gap.md` §8.4 (PR 8).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { executeDig } from '../../LinuxDnsService';
import { readResolverIP } from './resolverIP';

export const digCommand: LinuxCommand = {
  name: 'dig',
  needsNetworkContext: true,

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeDig(args, readResolverIP(ctx.executor));
  },
};
