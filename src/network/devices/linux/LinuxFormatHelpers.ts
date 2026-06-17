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
import type { TracerouteHop } from './LinuxNetKernel';
import { formatIfconfigInterface } from './LinuxNetCommands';

export interface LinuxFormatHelpers {
  /**
   * Render a full `ping` sequence output (header + per-packet + stats).
   * @param size Payload size in bytes (defaults to 56, as in the real ping).
   */
  formatPingOutput(target: IPAddress, count: number, results: PingResult[], size?: number, hostname?: string): string;

  /**
   * Render a full `ping6` sequence output. iputils formats the IPv6
   * header differently from IPv4: `PING <name>(<addr>) <size> data bytes`
   * (no `(size+28)` total, since the IPv6 header is not counted there).
   */
  formatPing6Output(target: IPv6Address, count: number, results: PingResult[], size?: number, hostname?: string): string;

  /**
   * Render a `traceroute` output including header and per-hop lines.
   * @param maxHops Advertised maxHops in the header (defaults to 30).
   */
  formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops?: number, hostname?: string): string;

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
    isConnected: port.isConnected(),
    isDHCP: false,
    counters: port.getCounters(),
    ipv6: port.getIPv6Addresses().map(entry => ({
      address: entry.address.toString(),
      prefixLength: entry.prefixLength,
      scope: entry.origin === 'link-local' ? 'link' as const : 'global' as const,
    })),
  });
}

export function formatPingHeader(target: IPAddress, size: number = 56, hostname?: string): string {
  const totalSize = size + 28; // ICMP header (8) + IP header (20)
  const displayName = hostname ?? target.toString();
  return `PING ${displayName} (${target}) ${size}(${totalSize}) bytes of data.`;
}

/** One `ping` reply line for a single probe, or null when the probe produced no line. */
export function formatPingReplyLine(r: PingResult, size: number = 56): string | null {
  if (r.success) {
    const replySize = size + 8; // data size + ICMP header
    return `${replySize} bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(3)} ms`;
  }
  if (r.error) {
    if (r.error.includes('Time to live exceeded')) {
      const match = r.error.match(/from ([\d.]+)/);
      return `From ${match ? match[1] : 'unknown'} icmp_seq=${r.seq} Time to live exceeded`;
    }
    if (r.error.includes('Destination unreachable')) {
      const match = r.error.match(/from ([\d.]+)/);
      return `From ${match ? match[1] : 'unknown'} icmp_seq=${r.seq} Destination Host Unreachable`;
    }
  }
  return null;
}

/** The trailing `--- statistics ---` block shared by block and streaming ping. */
export function formatPingStats(targetStr: string, count: number, results: PingResult[]): string[] {
  const received = results.filter(r => r.success);
  const failed = count - received.length;
  const lines = [
    '',
    `--- ${targetStr} ping statistics ---`,
    `${count} packets transmitted, ${received.length} received, ${count === 0 ? 0 : Math.round((failed / count) * 100)}% packet loss`,
  ];
  if (received.length > 0) {
    const rtts = received.map(r => r.rttMs);
    const min = Math.min(...rtts).toFixed(3);
    const max = Math.max(...rtts).toFixed(3);
    const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3);
    const mdev = (Math.sqrt(rtts.reduce((s, r) => s + (r - +avg) ** 2, 0) / rtts.length)).toFixed(3);
    lines.push(`rtt min/avg/max/mdev = ${min}/${avg}/${max}/${mdev} ms`);
  }
  return lines;
}

function formatPingOutput(target: IPAddress, count: number, results: PingResult[], size: number = 56, hostname?: string): string {
  return renderPingBody(formatPingHeader(target, size, hostname), String(target), count, results, size);
}

function formatPing6Output(target: IPv6Address, count: number, results: PingResult[], size: number = 56, hostname?: string): string {
  const displayName = hostname ?? target.toString();
  const header = `PING ${displayName}(${target}) ${size} data bytes`;
  return renderPingBody(header, String(target), count, results, size);
}

/** Per-packet lines + statistics block, shared by ping and ping6. */
function renderPingBody(header: string, targetStr: string, count: number, results: PingResult[], size: number): string {
  const lines: string[] = [header];
  if (results.length === 0) {
    lines.push('connect: Network is unreachable');
  } else {
    for (const r of results) {
      const line = formatPingReplyLine(r, size);
      if (line !== null) lines.push(line);
    }
  }
  lines.push(...formatPingStats(targetStr, count, results));
  return lines.join('\n');
}

function icmpCodeAnnotation(code: number | undefined): string {
  if (code === undefined) return '';
  switch (code) {
    case 0: return ' !N';
    case 1: return ' !H';
    case 2: return ' !P';
    case 3: return ' !P';
    case 13: return ' !A';
    default: return ` !${code}`;
  }
}

function formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops: number = 30, hostname?: string): string {
  const displayName = hostname ?? target.toString();
  if (hops.length === 0) {
    return `traceroute to ${displayName} (${target}), ${maxHops} hops max, 60 byte packets\n * * * Network is unreachable`;
  }
  const lines = [`traceroute to ${displayName} (${target}), ${maxHops} hops max, 60 byte packets`];
  for (const hop of hops) {
    const probes = hop.probes && hop.probes.length > 0 ? hop.probes : null;

    if (hop.timeout && (!probes || probes.every(p => !p.responded))) {
      lines.push(` ${hop.hop}  * * *`);
      continue;
    }

    if (probes && probes.length > 0) {
      const ip = hop.ip ?? '*';
      let line = ` ${hop.hop}  ${ip} (${ip})`;
      let lastIp = ip;
      for (const probe of probes) {
        if (!probe.responded) {
          line += '  *';
        } else {
          const probeIp = probe.ip ?? ip;
          if (probeIp !== lastIp) {
            line += `  ${probeIp} (${probeIp})`;
            lastIp = probeIp;
          }
          const annotation = icmpCodeAnnotation(probe.icmpCode);
          line += `  ${(probe.rttMs ?? 0).toFixed(3)} ms${annotation}`;
        }
      }
      lines.push(line);
    } else if (hop.unreachable) {
      const annotation = icmpCodeAnnotation(hop.icmpCode);
      lines.push(` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms${annotation}`);
    } else {
      lines.push(` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms`);
    }
  }
  return lines.join('\n');
}

/** Default singleton — no state, safe to share across machines. */
export const defaultLinuxFormatHelpers: LinuxFormatHelpers = {
  formatPingOutput,
  formatPing6Output,
  formatTracerouteOutput,
  formatInterface,
  formatBytes,
};
