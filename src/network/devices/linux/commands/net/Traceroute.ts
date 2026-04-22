/**
 * `traceroute` — record the path packets take to a destination.
 *
 * Drives the real `EndHost` traceroute path through
 * `ctx.net.traceroute(...)` and renders via
 * `ctx.fmt.formatTracerouteOutput(...)`.
 *
 * Extracted from `LinuxPC.cmdTraceroute`. See `linux_gap.md` §8.4 (PR 7).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const tracerouteCommand: LinuxCommand = {
  name: 'traceroute',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'traceroute [-InU] [-m maxhops] [-q nqueries] [-f first_ttl] [-w waittime] <destination>',
  help:
    'Print the route packets trace to network host.\n\n' +
    'Traces the path that an IP packet follows from the local host to a\n' +
    'remote destination by sending probe packets with increasing TTL values.',
  options: [
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.', takesArg: false },
    { flag: '-I', description: 'Use ICMP ECHO for probes (default is UDP).', takesArg: false },
    { flag: '-U', description: 'Use UDP datagrams for probes.', takesArg: false },
    { flag: '-m', description: 'Maximum TTL value for outbound probes.', takesArg: true, argName: 'maxhops' },
    { flag: '-q', description: 'Number of probes per hop (default 3).', takesArg: true, argName: 'nqueries' },
    { flag: '-f', description: 'Start from the first_ttl hop (default 1).', takesArg: true, argName: 'first_ttl' },
    { flag: '-w', description: 'Seconds to wait for a response.', takesArg: true, argName: 'waittime' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: traceroute [-InU] [-m maxhops] [-q nqueries] [-f first_ttl] <destination>';

    let targetStr = '';
    let maxHops = 30;
    let probesPerHop = 3;
    let firstTtl = 1;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') continue;
      if (a === '-I' || a === '-U') continue; // ICMP/UDP mode switch — cosmetic in simulation
      if ((a === '-m' || a === '-t') && args[i + 1]) { maxHops = parseInt(args[i + 1], 10); i++; continue; }
      if (a === '-q' && args[i + 1]) { probesPerHop = parseInt(args[i + 1], 10); i++; continue; }
      if (a === '-f' && args[i + 1]) { firstTtl = parseInt(args[i + 1], 10); i++; continue; }
      if (a === '-w' && args[i + 1]) { i++; continue; } // timeout — skip
      if (!a.startsWith('-')) { targetStr = a; }
    }

    if (!targetStr) return 'Usage: traceroute [-InU] [-m maxhops] [-q nqueries] [-f first_ttl] <destination>';

    const targetIP = ctx.net.resolveHostname(targetStr);
    if (!targetIP) {
      return `traceroute: unknown host ${targetStr}`;
    }

    const isHostname = targetStr !== targetIP.toString();
    const hops = await ctx.net.traceroute(targetIP, maxHops, probesPerHop, firstTtl);
    return ctx.fmt.formatTracerouteOutput(targetIP, hops, maxHops, isHostname ? targetStr : undefined);
  },
};
