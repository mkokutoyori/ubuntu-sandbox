import { IPAddress } from '../../core/types';
import type { EndHost, PingResult, TracerouteHopResult } from '../EndHost';

export const PATHPING_HELP = `
Usage: pathping [-g host-list] [-h maximum_hops] [-i address] [-n]
                [-p period] [-q num_queries] [-w timeout]
                [-4] [-6] target_name

Options:
    -g host-list   Loose source route along host-list.
    -h maximum_hops    Maximum number of hops to search for target.
    -i address     Use the specified source address.
    -n             Do not resolve addresses to hostnames.
    -p period      Wait period milliseconds between pings.
    -q num_queries Number of queries per hop.
    -w timeout     Wait timeout milliseconds for each reply.
    -4             Force using IPv4.
    -6             Force using IPv6.`.trim();

export interface ParsedWinPathping {
  maxHops: number;
  queriesPerHop: number;
  periodMs: number;
  timeoutMs: number;
  noResolve: boolean;
  targetStr: string;
}

export function parseWinPathpingArgs(args: string[]): ParsedWinPathping {
  let maxHops = 30;
  let queriesPerHop = 100;
  let periodMs = 250;
  let timeoutMs = 3000;
  let noResolve = false;
  let targetStr = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '-h' && args[i + 1]) { maxHops = parseInt(args[i + 1], 10) || 30; i++; }
    else if (a === '-q' && args[i + 1]) { queriesPerHop = parseInt(args[i + 1], 10) || 100; i++; }
    else if (a === '-p' && args[i + 1]) { periodMs = parseInt(args[i + 1], 10) || 250; i++; }
    else if (a === '-w' && args[i + 1]) { timeoutMs = parseInt(args[i + 1], 10) || 3000; i++; }
    else if (a === '-n') { noResolve = true; }
    else if ((a === '-g' || a === '-i') && args[i + 1]) { i++; }
    else if (a === '-4' || a === '-6') { /* family hint, ignored */ }
    else if (!a.startsWith('-') && !a.startsWith('/')) { targetStr = args[i]; }
  }

  return { maxHops, queriesPerHop, periodMs, timeoutMs, noResolve, targetStr };
}

export function formatPathpingHeader(target: IPAddress, maxHops: number, hostname?: string): string[] {
  const dest = hostname ? `${hostname} [${target}]` : `${target}`;
  return ['', `Tracing route to ${dest} over a maximum of ${maxHops} hops:`];
}

export function formatPathpingDiscoveryHop(hop: number, ip: string, hostname?: string): string {
  const num = String(hop).padStart(2);
  const addr = hostname ? `${hostname} [${ip}]` : ip;
  return `  ${num}  ${addr}`;
}

export function formatPathpingComputing(seconds: number): string[] {
  return ['', `Computing statistics for ${seconds} seconds...`];
}

export function formatPathpingTableHeader(): string[] {
  return [
    '            Source to Here   This Node/Link',
    'Hop  RTT    Lost/Sent = Pct  Lost/Sent = Pct  Address',
  ];
}

export interface PathpingStatsRow {
  hop: number;
  ip: string;
  hostname?: string;
  rttMs?: number;
  sourceLost: number;
  sourceSent: number;
  nodeLost: number;
  linkLost: number;
}

function fmtLossCell(lost: number, sent: number): string {
  const pct = sent > 0 ? Math.round((lost / sent) * 100) : 0;
  return `${String(lost).padStart(2)}/${String(sent).padStart(3)} = ${String(pct).padStart(2)}%`;
}

function fmtRttCell(rttMs?: number): string {
  if (rttMs === undefined) return '       ';
  const ms = Math.round(rttMs);
  return (ms < 1 ? '<1ms' : `${ms}ms`).padStart(5);
}

function fmtAddr(ip: string, hostname?: string): string {
  return hostname ? `${hostname} [${ip}]` : ip;
}

export function formatPathpingTable(rows: readonly PathpingStatsRow[], sent: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0) {
      out.push(`  ${String(row.hop).padStart(2)}                                           ${fmtAddr(row.ip, row.hostname)}`);
    } else {
      const rtt = fmtRttCell(row.rttMs);
      const src = fmtLossCell(row.sourceLost, row.sourceSent);
      const node = fmtLossCell(row.nodeLost, row.sourceSent);
      const link = fmtLossCell(row.linkLost, sent);
      out.push(`                                ${link}   |`);
      out.push(`  ${String(row.hop).padStart(2)}   ${rtt}     ${src}     ${node}   ${fmtAddr(row.ip, row.hostname)}`);
    }
  }
  return out;
}

export function formatPathpingTrailer(): string {
  return 'Trace complete.';
}

export function pathpingDurationSeconds(p: ParsedWinPathping, hopCount: number): number {
  return Math.max(1, Math.round((p.queriesPerHop * p.periodMs * hopCount) / 1000));
}

export interface PathpingIo {
  line(text: string): void;
  error(text: string): void;
  cancelled(): boolean;
  delay(milliseconds: number): Promise<void>;
}

export type PathpingDevice = Pick<EndHost, 'tracerouteStreamInSession' | 'pingStreamInSession' | 'getEgressIPFor' | 'getHostname'>;

export async function runPathping(device: PathpingDevice, parsed: ParsedWinPathping, io: PathpingIo): Promise<void> {
  const discovered: TracerouteHopResult[] = [];
  let resolvedTarget: IPAddress | null = null;
  const outcome = await device.tracerouteStreamInSession(parsed.targetStr, {
    maxHops: parsed.maxHops,
    probesPerHop: 1,
    timeoutMs: parsed.timeoutMs,
    onResolved: (ip, hostname) => {
      resolvedTarget = ip;
      for (const line of formatPathpingHeader(ip, parsed.maxHops, hostname)) io.line(line);
    },
    onHop: hop => { discovered.push(hop); },
    shouldStop: () => io.cancelled(),
  });
  if (io.cancelled()) return;
  if (!outcome.resolved || !resolvedTarget) {
    io.error(`Unable to resolve target system name ${parsed.targetStr}.`);
    return;
  }

  const sourceIp = device.getEgressIPFor(resolvedTarget)?.toString();
  const rows: PathpingStatsRow[] = [{
    hop: 0,
    ip: sourceIp ?? '0.0.0.0',
    hostname: parsed.noResolve ? undefined : device.getHostname(),
    rttMs: undefined,
    sourceLost: 0,
    sourceSent: 0,
    nodeLost: 0,
    linkLost: 0,
  }];
  let hopNumber = 0;
  for (const hop of discovered) {
    hopNumber++;
    if (!hop.ip) continue;
    io.line(formatPathpingDiscoveryHop(hopNumber, hop.ip));
    rows.push({
      hop: hopNumber, ip: hop.ip, hostname: undefined, rttMs: undefined,
      sourceLost: 0, sourceSent: 0, nodeLost: 0, linkLost: 0,
    });
  }
  if (rows.length <= 1) {
    io.error(`Unable to resolve target system name ${parsed.targetStr}.`);
    return;
  }

  for (const line of formatPathpingComputing(pathpingDurationSeconds(parsed, rows.length - 1))) io.line(line);

  for (let index = 1; index < rows.length; index++) {
    if (io.cancelled()) return;
    const row = rows[index];
    const rtts: number[] = [];
    const results: PingResult[] = [];
    await device.pingStreamInSession(row.ip, {
      count: parsed.queriesPerHop,
      timeoutMs: parsed.timeoutMs,
      intervalMs: parsed.periodMs,
      onResult: result => { results.push(result); if (result.success) rtts.push(result.rttMs); },
      shouldStop: () => io.cancelled(),
      sleep: milliseconds => io.delay(milliseconds),
    });
    row.sourceSent = results.length;
    row.sourceLost = results.filter(result => !result.success).length;
    if (rtts.length > 0) row.rttMs = rtts.reduce((total, value) => total + value, 0) / rtts.length;
  }
  if (io.cancelled()) return;

  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const previousRate = previous.sourceSent > 0 ? previous.sourceLost / previous.sourceSent : 0;
    const currentRate = current.sourceSent > 0 ? current.sourceLost / current.sourceSent : 0;
    current.linkLost = Math.round(Math.max(0, currentRate - previousRate) * current.sourceSent);
  }

  io.line('');
  for (const line of formatPathpingTableHeader()) io.line(line);
  for (const line of formatPathpingTable(rows, parsed.queriesPerHop)) io.line(line);
  io.line('');
  io.line(formatPathpingTrailer());
}
