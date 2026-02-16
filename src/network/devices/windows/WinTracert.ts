/**
 * Windows TRACERT command — trace route to destination.
 *
 * Supported:
 *   tracert <destination>           — trace route
 *   tracert -d <destination>        — do not resolve addresses
 *   tracert -h <maxhops> <dest>     — maximum number of hops
 *   tracert /?                      — usage help
 */

import type { WinCommandContext, TracerouteHop } from './WinCommandExecutor';
import { IPAddress } from '../../core/types';

const TRACERT_HELP = `
Usage: tracert [-d] [-h maximum_hops] [-j host-list] [-w timeout]
               [-R] [-S srcaddr] [-4] [-6] target_name

Options:
    -d                 Do not resolve addresses to hostnames.
    -h maximum_hops    Maximum number of hops to search for target.
    -j host-list       Loose source route along host-list (IPv4-only).
    -w timeout         Wait timeout milliseconds for each reply.
    -R                 Trace round-trip path (IPv6-only).
    -S srcaddr         Source address to use (IPv6-only).
    -4                 Force using IPv4.
    -6                 Force using IPv6.`.trim();

export async function cmdTracert(ctx: WinCommandContext, args: string[]): Promise<string> {
  if (args.length === 0 || args.includes('/?') || args.includes('/help')) {
    return TRACERT_HELP;
  }

  let targetStr = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if ((a === '-h' || a === '-w' || a === '-j') && args[i + 1]) { i++; }
    else if (!a.startsWith('-')) { targetStr = args[i]; }
  }

  if (!targetStr) return TRACERT_HELP;

  let targetIP: IPAddress;
  try { targetIP = new IPAddress(targetStr); }
  catch { return `Unable to resolve target system name ${targetStr}.`; }

  const hops = await ctx.executeTraceroute(targetIP);

  if (hops.length === 0) {
    return `Unable to resolve target system name ${targetStr}.`;
  }

  const lines = [
    '',
    `Tracing route to ${targetIP} over a maximum of 30 hops:`,
    '',
  ];
  for (const hop of hops) {
    if (hop.timeout) {
      lines.push(`  ${String(hop.hop).padStart(2)}     *        *        *     Request timed out.`);
    } else {
      const ms = Math.round(hop.rttMs!);
      const msStr = ms < 1 ? '<1 ms' : `${ms} ms`;
      lines.push(`  ${String(hop.hop).padStart(2)}    ${msStr.padEnd(8)} ${msStr.padEnd(8)} ${msStr.padEnd(8)} ${hop.ip}`);
    }
  }
  lines.push('');
  lines.push('Trace complete.');
  return lines.join('\n');
}
