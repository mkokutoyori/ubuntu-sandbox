/**
 * `ping` — ICMP echo request to a destination.
 *
 * Supports:
 *   ping [-c count] [-t ttl] <destination>
 *
 * Drives the real `EndHost` ICMP path through `ctx.net.pingSequence`
 * (so any `LinuxMachine` — including `LinuxServer` — gets a real ping
 * instead of the canned stub from `LinuxCommandExecutor`).
 *
 * The output is rendered by `ctx.fmt.formatPingOutput` so PC and
 * server emit byte-identical sequences.
 *
 * Extracted from `LinuxPC.cmdPing`. See `linux_gap.md` §8.4 (PR 6).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress } from '../../../../core/types';

export const pingCommand: LinuxCommand = {
  name: 'ping',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping [-c count] [-t ttl] [-s size] [-W timeout] [-i interval] <destination>',
  help: 'Send ICMP ECHO_REQUEST packets to network hosts.',
  options: [
    { flag: '-c', description: 'Stop after sending count ECHO_REQUEST packets.', takesArg: true, argName: 'count' },
    { flag: '-t', description: 'Set the IP Time to Live.', takesArg: true, argName: 'ttl' },
    { flag: '-s', description: 'ICMP payload size in bytes (default: 56).', takesArg: true, argName: 'size' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Interval in seconds between packets.', takesArg: true, argName: 'interval' },
  ],

  complete(_ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (partial.startsWith('-')) {
      return ['-c', '-t', '-s', '-W', '-i'].filter(f => f.startsWith(partial));
    }
    return [];
  },

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    let count = 4;
    let ttl: number | undefined;
    let size = 56;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) {
        count = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === '-t' && args[i + 1]) {
        ttl = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === '-s' && args[i + 1]) {
        size = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === '-W' && args[i + 1]) {
        i++; // timeout value accepted but not used in the simulation
      } else if (args[i] === '-i' && args[i + 1]) {
        i++; // interval value accepted but not used in the simulation
      } else if (!args[i].startsWith('-')) {
        targetStr = args[i];
      }
    }

    if (!targetStr) return 'Usage: ping [-c count] [-t ttl] [-s size] <destination>';

    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(targetStr);
    } catch {
      return `ping: ${targetStr}: Name or service not known`;
    }

    const results = await ctx.net.pingSequence(targetIP, count, 2000, ttl);
    return ctx.fmt.formatPingOutput(targetIP, count, results, size);
  },
};
