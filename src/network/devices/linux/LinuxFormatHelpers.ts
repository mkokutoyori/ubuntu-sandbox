/**
 * LinuxFormatHelpers - Shared GNU-like output formatters.
 *
 * Extracted so that individual command files (ping, traceroute, ifconfig,
 * ...) can produce exactly the same output regardless of which machine
 * (PC or server) they are attached to.
 *
 * Kept intentionally as a plain object (not a class) — this module has no
 * state, and that keeps the surface passed in `LinuxCommandContext.fmt`
 * trivial to mock in tests.
 *
 * See `linux_gap.md` §7.3 and §8.4.
 */

import type { IPAddress, IPv6Address } from '../../core/types';
import type { PingResult } from '../EndHost';
import type { Port } from '../../hardware/Port';
import { formatIfconfigInterface } from './LinuxNetCommands';
import { readIcmpUnreachable } from '../../core/icmpUnreachable';

export interface LinuxFormatHelpers {
  /** Render a single interface in `ifconfig` style (UP/BROADCAST/...). */
  formatInterface(port: Port): string;

  /** Render a human-readable size (B, KB, MB, GB). */
  formatBytes(bytes: number): string;
}

// ─── Default implementation ────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0.0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatInterface(port: Port): string {
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  return formatIfconfigInterface({
    name: port.getName(),
    mac: port.getMAC().toString(),
    ip: ip ? ip.toString() : null,
    mask: mask ? mask.toString() : null,
    cidr: mask ? mask.toCIDR() : null,
    mtu: port.getMTU(),
    isUp: port.getIsUp(),
    isConnected: port.hasCarrier(),
    isDHCP: false,
    counters: port.getCounters(),
    ipv6: port.getIPv6Addresses().map(entry => ({
      address: entry.address.toString(),
      prefixLength: entry.prefixLength,
      scope: entry.origin === 'link-local' ? 'link' as const : 'global' as const,
    })),
  });
}

export type PingAddressRenderer = (ip: string) => string;

const numericAddress: PingAddressRenderer = (ip) => ip;

export function formatPingHeader(
  target: IPAddress, size: number = 56, hostname?: string, bound?: { source: string; device?: string },
): string {
  const totalSize = size + 28;
  const displayName = hostname ?? target.toString();
  const from = bound === undefined ? '' : `from ${bound.source} ${bound.device ?? ''}: `;
  return `PING ${displayName} (${target}) ${from}${size}(${totalSize}) bytes of data.`;
}

export function isIcmpErrorResult(r: PingResult): boolean {
  return !r.success && !!r.error
    && /unreachable|Time to live exceeded|local error/i.test(r.error);
}

export function icmpUnreachText(code: number | undefined, mtu: number | undefined): string {
  switch (code) {
    case 0: return 'Destination Net Unreachable';
    case 1: return 'Destination Host Unreachable';
    case 2: return 'Destination Protocol Unreachable';
    case 3: return 'Destination Port Unreachable';
    case 4: return mtu !== undefined ? `Frag needed and DF set (mtu = ${mtu})` : 'Frag needed and DF set';
    case 9: return 'Destination Net Prohibited';
    case 10: return 'Destination Host Prohibited';
    case 13: return 'Packet filtered';
    default: return 'Destination Host Unreachable';
  }
}

export function formatPingFailureLine(
  r: PingResult, renderAddress: PingAddressRenderer = numericAddress,
): string | null {
  if (r.success) return null;
  if (r.error?.includes('Time to live exceeded')) {
    const m = /from ([\d.]+)/.exec(r.error);
    return `From ${m ? renderAddress(m[1]) : 'unknown'} icmp_seq=${r.seq} Time to live exceeded`;
  }
  const report = readIcmpUnreachable(r.error);
  if (!report) return null;
  const from = report.from || r.fromIP || 'unknown';
  return `From ${renderAddress(from)} icmp_seq=${r.seq} ${icmpUnreachText(report.code, report.mtu)}`;
}

export function formatPingRtt(rttMs: number): string {
  const triptime = Math.round(rttMs * 1000);
  if (triptime >= 100000 - 50) return `${Math.floor((triptime + 500) / 1000)}`;
  if (triptime >= 10000 - 5) {
    const rounded = triptime + 50;
    return `${Math.floor(rounded / 1000)}.${Math.floor((rounded % 1000) / 100)}`;
  }
  if (triptime >= 1000) {
    const rounded = triptime + 5;
    return `${Math.floor(rounded / 1000)}.${String(Math.floor((rounded % 1000) / 10)).padStart(2, '0')}`;
  }
  return `${Math.floor(triptime / 1000)}.${String(triptime % 1000).padStart(3, '0')}`;
}

export function formatPingReplyLine(
  r: PingResult, size: number = 56, renderAddress: PingAddressRenderer = numericAddress,
): string | null {
  if (r.success) {
    const timed = size >= PING_TIMING_MIN_SIZE ? ` time=${formatPingRtt(r.rttMs)} ms` : '';
    return `${size + 8} bytes from ${renderAddress(r.fromIP)}: icmp_seq=${r.seq} ttl=${r.ttl}${timed}`;
  }
  return formatPingFailureLine(r, renderAddress);
}

export const PING_TIMING_MIN_SIZE = 16;

export interface PingStatsOptions {
  timing?: boolean;
  flood?: boolean;
  dots?: string;
  ewmaMs?: number;
}

function microseconds(ms: number): number {
  return Math.round(ms * 1000);
}

function formatMicros(us: number): string {
  return `${Math.trunc(us / 1000)}.${String(Math.trunc(us % 1000)).padStart(3, '0')}`;
}

function formatLossPercent(loss: number): string {
  return String(Number(loss.toPrecision(6)));
}

export function formatPingStats(
  targetStr: string,
  count: number,
  results: PingResult[],
  elapsedMs?: number,
  options: PingStatsOptions = {},
): string[] {
  const received = results.filter(r => r.success);
  const errors = results.filter(isIcmpErrorResult).length;
  const summary = [
    `${count} packets transmitted`,
    `${received.length} received`,
    ...(errors > 0 ? [`+${errors} errors`] : []),
    ...(count === 0 ? [] : [`${formatLossPercent(((count - received.length) * 100) / count)}% packet loss`]),
    ...(count === 0 || elapsedMs === undefined ? [] : [`time ${Math.round(elapsedMs)}ms`]),
  ].join(', ');
  const lines = [
    options.flood ? options.dots ?? '' : '',
    `--- ${targetStr} ping statistics ---`,
    summary,
  ];
  const tail: string[] = [];
  if (received.length > 0 && options.timing !== false) {
    const trips = received.map(r => microseconds(r.rttMs));
    const total = trips.length;
    const tsum = trips.reduce((a, b) => a + b, 0);
    const tsum2 = trips.reduce((a, b) => a + b * b, 0);
    const tmavg = Math.trunc(tsum / total);
    const tmvar = Math.trunc((tsum2 - Math.trunc((tsum * tsum) / total)) / total);
    const tmdev = Math.floor(Math.sqrt(Math.max(0, tmvar)));
    tail.push(`rtt min/avg/max/mdev = ${formatMicros(Math.min(...trips))}/${formatMicros(tmavg)}`
      + `/${formatMicros(Math.max(...trips))}/${formatMicros(tmdev)} ms`);
  }
  if (options.flood && received.length > 0 && count > 1 && elapsedMs !== undefined && options.ewmaMs !== undefined) {
    const ipg = Math.trunc(microseconds(elapsedMs) / (count - 1));
    const ewma = microseconds(options.ewmaMs);
    tail.push(`ipg/ewma ${formatMicros(ipg)}/${formatMicros(ewma)} ms`);
  }
  lines.push(tail.join(', '));
  return tail.length === 0 && elapsedMs === undefined ? lines.slice(0, -1) : lines;
}

export function formatPing6Header(
  target: IPv6Address, size: number = 56, hostname?: string,
): string {
  const displayName = hostname ?? target.toString();
  return `PING ${displayName}(${target}) ${size} data bytes`;
}

/** Default singleton — no state, safe to share across machines. */
export const defaultLinuxFormatHelpers: LinuxFormatHelpers = {
  formatInterface,
  formatBytes,
};
