/**
 * Windows TRACERT command — trace route to destination.
 *
 * Supported:
 *   tracert <destination>           — trace route
 *   tracert -d <destination>        — do not resolve addresses
 *   tracert -h <maxhops> <dest>     — maximum number of hops
 *   tracert /?                      — usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';
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

interface TracertHopView {
  hop: number;
  ip?: string;
  rttMs?: number;
  timeout: boolean;
  unreachable?: boolean;
  probes?: Array<{ responded: boolean; rttMs?: number }>;
}

export function formatWinTracertHeader(target: IPAddress, maxHops: number, hostname?: string): string[] {
  const dest = hostname ? `${hostname} [${target}]` : `${target}`;
  return ['', `Tracing route to ${dest} over a maximum of ${maxHops} hops:`, ''];
}

export function formatWinTracertHop(hop: TracertHopView): string {
  const num = String(hop.hop).padStart(2);
  const slot = '*'.padStart(5).padEnd(8);

  if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
    return `  ${num}     *        *        *     Request timed out.`;
  }

  let line: string;
  if (hop.probes && hop.probes.length > 0) {
    const cols: string[] = [];
    for (const probe of hop.probes) {
      if (!probe.responded) cols.push(slot);
      else {
        const ms = Math.round(probe.rttMs ?? 0);
        cols.push((ms < 1 ? '<1 ms' : `${ms} ms`).padEnd(8));
      }
    }
    while (cols.length < 3) cols.push(slot);
    line = `  ${num}    ${cols.join(' ')} ${hop.ip}`;
  } else {
    const ms = Math.round(hop.rttMs ?? 0);
    const msStr = (ms < 1 ? '<1 ms' : `${ms} ms`).padEnd(8);
    line = `  ${num}    ${msStr} ${msStr} ${msStr} ${hop.ip}`;
  }
  if (hop.unreachable) line += '\n        Destination net unreachable.';
  return line;
}

export async function cmdTracert(ctx: WinCommandContext, args: string[]): Promise<string> {
  if (args.length === 0 || args.includes('/?') || args.includes('/help')) {
    return TRACERT_HELP;
  }

  let targetStr = '';
  let maxHops = 30;

  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '-h' && args[i + 1]) { maxHops = parseInt(args[i + 1], 10) || 30; i++; }
    else if ((a === '-w' || a === '-j' || a === '-s') && args[i + 1]) { i++; }
    else if (!a.startsWith('-') && !a.startsWith('/')) { targetStr = args[i]; }
  }

  if (!targetStr) return TRACERT_HELP;

  const targetIP = await ctx.resolveHostname(targetStr);
  if (!targetIP) {
    return `Unable to resolve target system name ${targetStr}.`;
  }

  const hops = await ctx.executeTraceroute(targetIP, maxHops);
  if (hops.length === 0) {
    return `Unable to resolve target system name ${targetStr}.`;
  }

  const hostname = targetStr !== targetIP.toString() ? targetStr : undefined;
  const lines = [...formatWinTracertHeader(targetIP, maxHops, hostname)];
  for (const hop of hops) lines.push(formatWinTracertHop(hop));
  lines.push('');
  lines.push('Trace complete.');
  return lines.join('\n');
}
