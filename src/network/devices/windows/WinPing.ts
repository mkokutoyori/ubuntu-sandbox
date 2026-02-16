/**
 * Windows PING command — ICMP echo requests.
 *
 * Supported:
 *   ping <destination>             — ping with default 4 packets
 *   ping -n <count> <destination>  — specify packet count
 *   ping -l <size> <destination>   — specify packet size (cosmetic)
 *   ping -t <destination>          — continuous ping (capped at 10)
 *   ping -i <ttl> <destination>    — set TTL
 *   ping /?                        — full usage help
 */

import type { WinCommandContext, PingResult } from './WinCommandExecutor';
import { IPAddress } from '../../core/types';

const PING_HELP = `
Usage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] [-v TOS]
            [-r count] [-s count] [[-j host-list] | [-k host-list]]
            [-w timeout] [-R] [-S srcaddr] [-c compartment] [-p]
            [-4] [-6] target_name

Options:
    -t             Ping the specified host until stopped.
                   To see statistics and continue - type Control-Break;
                   To stop - type Control-C.
    -a             Resolve addresses to hostnames.
    -n count       Number of echo requests to send.
    -l size        Send buffer size.
    -f             Set Don't Fragment flag in packet (IPv4-only).
    -i TTL         Time To Live.
    -v TOS         Type Of Service (IPv4-only. This setting has been deprecated
                   and has no effect on the type of service field in the IP
                   Header).
    -r count       Record route for count hops (IPv4-only).
    -s count       Timestamp for count hops (IPv4-only).
    -j host-list   Loose source route along host-list (IPv4-only).
    -k host-list   Strict source route along host-list (IPv4-only).
    -w timeout     Timeout in milliseconds to wait for each reply.
    -R             Use routing header to test reverse route also (IPv6-only).
                   Per RFC 5095 the use of this routing header has been
                   deprecated. Some systems may drop echo requests if
                   this header is used.
    -S srcaddr     Source address to use.
    -c compartment Routing compartment identifier.
    -p             Ping a Hyper-V Network Virtualization provider address.
    -4             Force using IPv4.
    -6             Force using IPv6.`.trim();

export async function cmdPing(ctx: WinCommandContext, args: string[]): Promise<string> {
  if (args.length === 0 || args.includes('/?') || args.includes('/help')) {
    return PING_HELP;
  }

  let count = 4;
  let size = 32;
  let ttl: number | undefined;
  let targetStr = '';
  let continuous = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '-n' && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
    else if (a === '-l' && args[i + 1]) { size = parseInt(args[i + 1], 10); i++; }
    else if (a === '-i' && args[i + 1]) { ttl = parseInt(args[i + 1], 10); i++; }
    else if ((a === '-c' || a === '-w' || a === '-r' || a === '-s' || a === '-v') && args[i + 1]) { i++; } // skip unsupported value args
    else if (a === '-t') { continuous = true; count = 10; } // cap continuous at 10
    else if (!a.startsWith('-')) { targetStr = args[i]; }
  }

  if (!targetStr) return PING_HELP;

  let targetIP: IPAddress;
  try { targetIP = new IPAddress(targetStr); }
  catch { return `Ping request could not find host ${targetStr}. Please check the name and try again.`; }

  const results = await ctx.executePingSequence(targetIP, count, 2000, ttl);
  return formatPingOutput(targetIP, count, size, results);
}

function formatPingOutput(targetIP: IPAddress, count: number, size: number, results: PingResult[]): string {
  const lines: string[] = [];
  lines.push(`\nPinging ${targetIP} with ${size} bytes of data:`);

  const received = results.filter(r => r.success);
  const lost = count - received.length;

  if (results.length === 0) {
    for (let i = 0; i < count; i++) lines.push('PING: transmit failed. General failure.');
  } else {
    for (const r of results) {
      if (r.success) {
        const ms = r.rttMs < 1 ? '<1ms' : `${Math.round(r.rttMs)}ms`;
        lines.push(`Reply from ${r.fromIP}: bytes=${size} time=${ms} TTL=${r.ttl}`);
      } else if (r.error) {
        if (r.error.includes('Time to live exceeded')) {
          const match = r.error.match(/from ([\d.]+)/);
          const fromIP = match ? match[1] : 'unknown';
          lines.push(`Reply from ${fromIP}: TTL expired in transit.`);
        } else if (r.error.includes('Destination unreachable')) {
          const match = r.error.match(/from ([\d.]+)/);
          const fromIP = match ? match[1] : 'unknown';
          lines.push(`Reply from ${fromIP}: Destination host unreachable.`);
        } else {
          lines.push('Request timed out.');
        }
      } else {
        lines.push('Request timed out.');
      }
    }
  }

  lines.push('');
  lines.push(`Ping statistics for ${targetIP}:`);
  lines.push(`    Packets: Sent = ${count}, Received = ${received.length}, Lost = ${lost} (${Math.round((lost / count) * 100)}% loss),`);

  if (received.length > 0) {
    const rtts = received.map(r => Math.round(r.rttMs));
    const min = Math.min(...rtts);
    const max = Math.max(...rtts);
    const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
    lines.push('Approximate round trip times in milli-seconds:');
    lines.push(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
  }

  return lines.join('\n');
}
