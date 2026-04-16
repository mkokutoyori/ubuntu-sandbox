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
import { IPAddress } from '../../../../core/types';

export const tracerouteCommand: LinuxCommand = {
  name: 'traceroute',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'traceroute [-n] [-m maxhops] [-q nqueries] [-w waittime] <destination>',
  help:
    'Print the route packets trace to network host.\n\n' +
    'Traces the path that an IP packet follows from the local host to a\n' +
    'remote destination by sending probe packets with increasing TTL values.',
  options: [
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.', takesArg: false },
    { flag: '-m', description: 'Maximum TTL value for outbound probes.', takesArg: true, argName: 'maxhops' },
    { flag: '-q', description: 'Number of probes per hop.', takesArg: true, argName: 'nqueries' },
    { flag: '-w', description: 'Seconds to wait for a response.', takesArg: true, argName: 'waittime' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: traceroute [-n] [-m maxhops] <destination>';

    let targetStr = '';
    let maxHops = 30;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') continue; // numeric (cosmetic in simulation)
      if (args[i] === '-m' && args[i + 1]) { maxHops = parseInt(args[i + 1], 10); i++; continue; }
      if (args[i] === '-q' && args[i + 1]) { i++; continue; } // skip nqueries
      if (args[i] === '-w' && args[i + 1]) { i++; continue; } // skip waittime
      if (!args[i].startsWith('-')) { targetStr = args[i]; }
    }

    if (!targetStr) return 'Usage: traceroute [-n] [-m maxhops] <destination>';

    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(targetStr);
    } catch {
      return `traceroute: unknown host ${targetStr}`;
    }

    const hops = await ctx.net.traceroute(targetIP, maxHops);
    return ctx.fmt.formatTracerouteOutput(targetIP, hops, maxHops);
  },
};
