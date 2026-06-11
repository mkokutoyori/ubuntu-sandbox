/**
 * `ping` / `ping6` — ICMP(v6) echo request to a destination.
 *
 * Supports:
 *   ping  [-4|-6] [-c count] [-t ttl] <destination>
 *   ping6 [-c count] <destination>
 *
 * Drives the real `EndHost` ICMP path through `ctx.net.pingSequence`
 * (IPv4) or `ctx.net.ping6Sequence` (IPv6 — real NDP + route
 * resolution), so any `LinuxMachine` — including `LinuxServer` — gets
 * a real ping instead of the canned stub from `LinuxCommandExecutor`.
 *
 * The output is rendered by `ctx.fmt.formatPingOutput` /
 * `formatPing6Output` so PC and server emit byte-identical sequences.
 *
 * Extracted from `LinuxPC.cmdPing`. See `linux_gap.md` §8.4 (PR 6).
 */

import { IPv6Address } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const PING_FLAGS = ['-c', '-t', '-s', '-W', '-i', '-4', '-6'];

function completePingFlags(_ctx: LinuxCommandContext, args: string[]): string[] {
  const partial = args[args.length - 1] ?? '';
  if (partial.startsWith('-')) {
    return PING_FLAGS.filter(f => f.startsWith(partial));
  }
  return [];
}

/**
 * Shared engine for `ping`, `ping -6` and `ping6` (iputils merged
 * ping6 into ping; both spellings drive the same code — same here).
 */
async function runPing(
  ctx: LinuxCommandContext, args: string[], cmdName: 'ping' | 'ping6',
): Promise<string> {
  let count = 4;
  let ttl: number | undefined;
  let size = 56;
  let targetStr = '';
  let v6 = cmdName === 'ping6';

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
    } else if (args[i] === '-6') {
      v6 = true;
    } else if (!args[i].startsWith('-')) {
      targetStr = args[i];
    }
  }

  if (!targetStr) return `Usage: ${cmdName} [-c count] [-t ttl] [-s size] <destination>`;

  // A literal IPv6 target selects the v6 path even without `-6`,
  // matching iputils' address-family auto-detection.
  if (!v6 && targetStr.includes(':')) v6 = true;

  if (v6) {
    let targetIP6: IPv6Address;
    try {
      targetIP6 = new IPv6Address(targetStr);
    } catch {
      return `${cmdName}: ${targetStr}: Name or service not known`;
    }
    const results = await ctx.net.ping6Sequence(targetIP6, count, 2000);
    return ctx.fmt.formatPing6Output(targetIP6, count, results, size);
  }

  const targetIP = await ctx.net.resolveHostname(targetStr);
  if (!targetIP) {
    return `${cmdName}: ${targetStr}: Name or service not known`;
  }

  const isHostname = targetStr !== targetIP.toString();
  const results = await ctx.net.pingSequence(targetIP, count, 2000, ttl);
  return ctx.fmt.formatPingOutput(targetIP, count, results, size, isHostname ? targetStr : undefined);
}

export const pingCommand: LinuxCommand = {
  name: 'ping',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping [-4|-6] [-c count] [-t ttl] [-s size] [-W timeout] [-i interval] <destination>',
  help: 'Send ICMP ECHO_REQUEST packets to network hosts.',
  options: [
    { flag: '-c', description: 'Stop after sending count ECHO_REQUEST packets.', takesArg: true, argName: 'count' },
    { flag: '-t', description: 'Set the IP Time to Live.', takesArg: true, argName: 'ttl' },
    { flag: '-s', description: 'ICMP payload size in bytes (default: 56).', takesArg: true, argName: 'size' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Interval in seconds between packets.', takesArg: true, argName: 'interval' },
    { flag: '-6', description: 'Use IPv6 only.' },
  ],

  complete: completePingFlags,

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return runPing(ctx, args, 'ping');
  },
};

export const ping6Command: LinuxCommand = {
  name: 'ping6',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ping6 [-c count] [-s size] [-W timeout] [-i interval] <destination>',
  help: 'Send ICMPv6 ECHO_REQUEST packets to network hosts (alias for ping -6).',
  options: [
    { flag: '-c', description: 'Stop after sending count ECHO_REQUEST packets.', takesArg: true, argName: 'count' },
    { flag: '-s', description: 'ICMP payload size in bytes (default: 56).', takesArg: true, argName: 'size' },
    { flag: '-W', description: 'Time to wait for a response, in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-i', description: 'Interval in seconds between packets.', takesArg: true, argName: 'interval' },
  ],

  complete: completePingFlags,

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return runPing(ctx, args, 'ping6');
  },
};
