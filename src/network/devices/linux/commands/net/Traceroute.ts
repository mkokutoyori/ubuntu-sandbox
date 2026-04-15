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

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: traceroute <destination>';

    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(args[0]);
    } catch {
      return `traceroute: unknown host ${args[0]}`;
    }

    const hops = await ctx.net.traceroute(targetIP);
    return ctx.fmt.formatTracerouteOutput(targetIP, hops);
  },
};
