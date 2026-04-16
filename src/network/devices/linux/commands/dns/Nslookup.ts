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
  manSection: 1,
  usage: 'nslookup [name] [server]',
  help:
    'Query Internet name servers interactively.\n\n' +
    'Queries the specified DNS server (or the system default) for\n' +
    'information about the given hostname.\n\n' +
    'OPTIONS\n' +
    '  name          The domain name to look up.\n' +
    '  server        The DNS server to query.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeNslookup(args, readResolverIP(ctx.executor));
  },
};
