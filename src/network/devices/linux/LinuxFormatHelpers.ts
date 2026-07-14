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

import type { Port } from '../../hardware/Port';
import { formatIfconfigInterface } from './LinuxNetCommands';

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

/** Default singleton — no state, safe to share across machines. */
export const defaultLinuxFormatHelpers: LinuxFormatHelpers = {
  formatInterface,
  formatBytes,
};
