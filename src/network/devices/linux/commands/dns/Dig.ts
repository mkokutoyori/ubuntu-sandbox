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
import { executeDig } from './DigRunner';
import { readResolverIP } from './resolverIP';
import { makeArgCompleter } from '../completionHelpers';

const DNS_RECORD_TYPES = ['A', 'AAAA', 'ANY', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];

export const digCommand: LinuxCommand = {
  name: 'dig',
  needsNetworkContext: true,
  complete(ctx, args) {
    const partial = args[args.length - 1] ?? '';
    if (args.length >= 2 && partial === partial.toUpperCase() && partial.length > 0) {
      const types = DNS_RECORD_TYPES.filter(t => t.startsWith(partial.toUpperCase()));
      if (types.length > 0) return types;
    }
    return makeArgCompleter({ hostsAtBarePosition: true })(ctx, args);
  },
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

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return executeDig(
      args,
      (s, n, t, ms, opts) => ctx.net.queryDns(s, n, t, ms, opts),
      readResolverIP(ctx.executor),
      (path) => ctx.executor.readFile(path),
    );
  },
};
