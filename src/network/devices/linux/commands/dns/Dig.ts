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
  manSection: 1,
  usage: 'dig [@server] [name] [type]',
  help:
    'DNS lookup utility.\n\n' +
    'Performs DNS lookups and displays the answers returned by the name\n' +
    'server(s). The default query is for an A record.\n\n' +
    'OPTIONS\n' +
    '  @server       Query this specific DNS server.\n' +
    '  name          The domain name to look up.\n' +
    '  type          The query type (A, AAAA, MX, NS, etc.).',

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeDig(args, readResolverIP(ctx.executor));
  },
};
