/**
 * `nslookup` — cross-platform DNS lookup utility.
 *
 * Thin wrapper around `executeNslookup` from `LinuxDnsService`.
 *
 * See `linux_gap.md` §8.4 (PR 8).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { executeNslookup } from '../../LinuxDnsService';
import { readResolverIP } from './resolverIP';

export const nslookupCommand: LinuxCommand = {
  name: 'nslookup',
  needsNetworkContext: true,

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeNslookup(args, readResolverIP(ctx.executor));
  },
};
