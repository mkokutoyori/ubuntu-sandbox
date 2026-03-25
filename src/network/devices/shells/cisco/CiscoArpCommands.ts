/**
 * CiscoArpCommands — Shared ARP command implementations for Cisco IOS CLI.
 *
 * Works on both routers and switches via the ARPProvider interface,
 * eliminating duplication of ARP commands across device types.
 *
 * Commands:
 *   show arp / show ip arp [<ip>|<interface>]  — display ARP table
 *   clear arp-cache                            — clear dynamic entries
 *   arp <ip> <mac> arpa                        — add static entry (config)
 *   no arp <ip>                                — remove entry (config)
 */

import { MACAddress } from '../../../core/types';
import type { Port } from '../../../hardware/Port';
import type { CommandTrie } from '../CommandTrie';

// ─── ARPProvider Interface ──────────────────────────────────────────

/** Entry in the ARP table (dynamic or static) */
export interface CiscoARPEntry {
  mac: MACAddress;
  iface: string;
  timestamp: number;
  type: 'dynamic' | 'static';
}

/**
 * Interface that a device must satisfy to support Cisco ARP commands.
 * Both Router and Switch implement this.
 */
export interface ARPProvider {
  _getArpTableInternal(): Map<string, CiscoARPEntry>;
  _addStaticARP(ip: string, mac: MACAddress, iface: string): void;
  _deleteARP(ip: string): boolean;
  _clearARPCache(): void;
  _getPortsInternal(): Map<string, Port>;
}

// ─── Show ARP ───────────────────────────────────────────────────────

/**
 * Format the ARP table for display (Cisco IOS format).
 * Supports optional filtering by IP address or interface name.
 */
export function showArp(provider: ARPProvider, filterArgs?: string[]): string {
  const arpTable = provider._getArpTableInternal();
  let entries = Array.from(arpTable.entries());

  if (filterArgs && filterArgs.length > 0) {
    const filter = filterArgs.join(' ');
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(filter);
    if (isIP) {
      entries = entries.filter(([ip]) => ip === filter);
    } else {
      entries = entries.filter(([, entry]) => entry.iface === filter);
    }
  }

  if (entries.length === 0) return 'No ARP entries.';

  const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface'];
  for (const [ip, entry] of entries) {
    const isStatic = entry.type === 'static';
    const age = isStatic ? '-' : String(Math.floor((Date.now() - entry.timestamp) / 60000));
    const suffix = isStatic
      ? `ARPA   ${entry.iface}\n                                                       static`
      : `ARPA   ${entry.iface}`;
    lines.push(`Internet  ${ip.padEnd(17)}${age.padEnd(12)}${entry.mac.toString().padEnd(16)}${suffix}`);
  }
  return lines.join('\n');
}

// ─── Command Registration: Show Commands ────────────────────────────

/**
 * Register ARP show commands on a trie (user + privileged modes).
 */
export function registerArpShowCommands(
  trie: CommandTrie,
  getProvider: () => ARPProvider,
): void {
  trie.registerGreedy('show arp', 'Display ARP table', (args) =>
    showArp(getProvider(), args.length > 0 ? args : undefined),
  );
  trie.registerGreedy('show ip arp', 'Display ARP table', (args) =>
    showArp(getProvider(), args.length > 0 ? args : undefined),
  );
}

/**
 * Register `clear arp-cache` on a trie (privileged mode).
 */
export function registerArpPrivilegedCommands(
  trie: CommandTrie,
  getProvider: () => ARPProvider,
): void {
  trie.register('clear arp-cache', 'Clear ARP cache', () => {
    getProvider()._clearARPCache();
    return '';
  });
}

// ─── Command Registration: Config Commands ──────────────────────────

/**
 * Register `arp <ip> <mac> arpa` and `no arp <ip>` on a config trie.
 */
export function registerArpConfigCommands(
  trie: CommandTrie,
  getProvider: () => ARPProvider,
): void {
  trie.registerGreedy('arp', 'Add static ARP entry', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const ip = args[0];
    const macStr = args[1];
    let mac: MACAddress;
    try {
      mac = new MACAddress(macStr);
    } catch {
      return `% Invalid MAC address "${macStr}"`;
    }
    // Determine interface: first port with an IP, or first port
    let iface = '';
    for (const [name, port] of getProvider()._getPortsInternal()) {
      if (port.getIPAddress()) {
        iface = name;
        break;
      }
    }
    if (!iface) {
      const first = getProvider()._getPortsInternal().keys().next().value;
      if (first) iface = first;
    }
    getProvider()._addStaticARP(ip, mac, iface);
    return '';
  });

  trie.registerGreedy('no arp', 'Remove ARP entry', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    getProvider()._deleteARP(args[0]);
    return '';
  });
}
