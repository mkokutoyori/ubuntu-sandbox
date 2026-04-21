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
import type { PingResult } from '../EndHost';
import type { Port } from '../../hardware/Port';
import type { TracerouteHop } from './LinuxNetKernel';

export interface LinuxFormatHelpers {
  /**
   * Render a full `ping` sequence output (header + per-packet + stats).
   * @param size Payload size in bytes (defaults to 56, as in the real ping).
   */
  formatPingOutput(target: IPAddress, count: number, results: PingResult[], size?: number): string;

  /**
   * Render a `traceroute` output including header and per-hop lines.
   * @param maxHops Advertised maxHops in the header (defaults to 30).
   */
  formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops?: number): string;

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
  const mac = port.getMAC();
  const isUp = port.getIsUp();
  const isConnected = port.isConnected();
  const hasCarrier = isUp && isConnected;
  const flags: string[] = [];
  if (isUp) flags.push('UP');
  flags.push('BROADCAST');
  if (hasCarrier) flags.push('RUNNING');
  flags.push('MULTICAST');
  const flagsStr = flags.join(',');
  const flagNum = hasCarrier ? 4163 : 4099;
  const counters = port.getCounters();
  return [
    `${port.getName()}: flags=${flagNum}<${flagsStr}>  mtu ${port.getMTU()}`,
    ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
    `        ether ${mac}`,
    `        RX packets ${counters.framesIn}  bytes ${counters.bytesIn} (${formatBytes(counters.bytesIn)})`,
    `        TX packets ${counters.framesOut}  bytes ${counters.bytesOut} (${formatBytes(counters.bytesOut)})`,
  ].join('\n');
}

function formatPingOutput(target: IPAddress, count: number, results: PingResult[], size: number = 56): string {
  const lines: string[] = [];
  const totalSize = size + 28; // ICMP header (8) + IP header (20)
  lines.push(`PING ${target} (${target}) ${size}(${totalSize}) bytes of data.`);

  const received = results.filter(r => r.success);
  const failed = count - received.length;

  if (results.length === 0) {
    lines.push('connect: Network is unreachable');
  } else {
    for (const r of results) {
      if (r.success) {
        const replySize = size + 8; // data size + ICMP header
        lines.push(`${replySize} bytes from ${r.fromIP}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(3)} ms`);
      } else if (r.error) {
        if (r.error.includes('Time to live exceeded')) {
          const match = r.error.match(/from ([\d.]+)/);
          const fromIP = match ? match[1] : 'unknown';
          lines.push(`From ${fromIP} icmp_seq=${r.seq} Time to live exceeded`);
        } else if (r.error.includes('Destination unreachable')) {
          const match = r.error.match(/from ([\d.]+)/);
          const fromIP = match ? match[1] : 'unknown';
          lines.push(`From ${fromIP} icmp_seq=${r.seq} Destination Host Unreachable`);
        }
      }
    }
  }

  lines.push('');
  lines.push(`--- ${target} ping statistics ---`);
  lines.push(`${count} packets transmitted, ${received.length} received, ${Math.round((failed / count) * 100)}% packet loss`);

  if (received.length > 0) {
    const rtts = received.map(r => r.rttMs);
    const min = Math.min(...rtts).toFixed(3);
    const max = Math.max(...rtts).toFixed(3);
    const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3);
    const mdev = (Math.sqrt(rtts.reduce((s, r) => s + (r - +avg) ** 2, 0) / rtts.length)).toFixed(3);
    lines.push(`rtt min/avg/max/mdev = ${min}/${avg}/${max}/${mdev} ms`);
  }

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

function formatTracerouteOutput(target: IPAddress, hops: TracerouteHop[], maxHops: number = 30): string {
  if (hops.length === 0) {
    return `traceroute to ${target} (${target}), ${maxHops} hops max, 60 byte packets\n * * * Network is unreachable`;
  }
  const lines = [`traceroute to ${target} (${target}), ${maxHops} hops max, 60 byte packets`];
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
  formatTracerouteOutput,
  formatInterface,
  formatBytes,
};
