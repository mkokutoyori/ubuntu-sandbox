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
  manSection: 1,
  usage: 'host [name] [server]',
  help:
    'DNS lookup utility.\n\n' +
    'A simple utility for performing DNS lookups. It is normally used\n' +
    'to convert names to IP addresses and vice versa.\n\n' +
    'OPTIONS\n' +
    '  name          The domain name or IP address to look up.\n' +
    '  server        The DNS server to query.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    return executeHost(args, readResolverIP(ctx.executor));
  },
};
