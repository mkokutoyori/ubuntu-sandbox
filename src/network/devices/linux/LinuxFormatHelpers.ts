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

import type { IPAddress } from '../../core/types';
import type { Port } from '../../hardware/Port';
import type { TracerouteHop } from './LinuxNetKernel';
import { formatIfconfigInterface } from './LinuxNetCommands';

export interface LinuxFormatHelpers {
  /**
   * Render a `traceroute` output including header and per-hop lines.
   * @param maxHops Advertised maxHops in the header (defaults to 30).
   */
  formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops?: number, hostname?: string): string;

  /** Render the `traceroute` banner line on its own (for streaming output). */
  formatTracerouteHeader(target: IPAddress, maxHops?: number, hostname?: string): string;

  /** Render a single `traceroute` hop line (for streaming, one hop at a time). */
  formatTracerouteHopLine(hop: TracerouteHop): string;

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

export function icmpCodeAnnotation(code: number | undefined): string {
  if (code === undefined) return '';
  switch (code) {
    case 0: return ' !N (Net unreachable)';
    case 1: return ' !H (Host unreachable)';
    case 2: return ' !P (Protocol unreachable)';
    case 3: return ' !P (Port unreachable)';
    case 13: return ' !A (Admin prohibited)';
    default: return ` !${code} (unreachable)`;
  }
}

export function formatTracerouteHeader(target: IPAddress, maxHops: number = 30, hostname?: string): string {
  const displayName = hostname ?? target.toString();
  return `traceroute to ${displayName} (${target}), ${maxHops} hops max, 60 byte packets`;
}

export function formatTracerouteHopLine(hop: TracerouteHop): string {
  const probes = hop.probes && hop.probes.length > 0 ? hop.probes : null;

  if (hop.timeout && (!probes || probes.every(p => !p.responded))) {
    return ` ${hop.hop}  * * *`;
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
    return line;
  }

  if (hop.unreachable) {
    const annotation = icmpCodeAnnotation(hop.icmpCode);
    return ` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms${annotation}`;
  }
  return ` ${hop.hop}  ${hop.ip} (${hop.ip})  ${(hop.rttMs ?? 0).toFixed(3)} ms`;
}

function formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops: number = 30, hostname?: string): string {
  const header = formatTracerouteHeader(target, maxHops, hostname);
  if (hops.length === 0) {
    const lines: string[] = [header];
    for (let i = 1; i <= Math.min(3, maxHops); i++) {
      lines.push(` ${i}  * * *`);
    }
    return lines.join('\n');
  }
  return [header, ...hops.map(formatTracerouteHopLine)].join('\n');
}

/** Default singleton — no state, safe to share across machines. */
export const defaultLinuxFormatHelpers: LinuxFormatHelpers = {
  formatTracerouteOutput,
  formatTracerouteHeader,
  formatTracerouteHopLine,
  formatInterface,
  formatBytes,
};
