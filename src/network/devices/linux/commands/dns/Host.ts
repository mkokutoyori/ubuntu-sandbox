/**
 * `host` — simple DNS lookup utility.
 *
 * Thin wrapper around `executeHost` from `LinuxDnsService`.
 *
 * See `linux_gap.md` §8.4 (PR 8).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { executeHost } from '../../LinuxDnsService';
import { readResolverIP } from './resolverIP';

export const hostCommand: LinuxCommand = {
  name: 'host',
  needsNetworkContext: true,

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeHost(args, readResolverIP(ctx.executor));
  },
};
