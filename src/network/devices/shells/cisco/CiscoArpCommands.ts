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

import { IPAddress, MACAddress } from '../../../core/types';
import type { ARPProvider, CiscoARPEntry } from '../CiscoDevice';
import type { CommandTrie } from '../CommandTrie';

// Re-export for backward compatibility
export type { CiscoARPEntry, ARPProvider } from '../CiscoDevice';

const ARP_IFACE_PREFIXES: Record<string, string> = {
  fa: 'FastEthernet', fas: 'FastEthernet', fast: 'FastEthernet', fastethernet: 'FastEthernet',
  gi: 'GigabitEthernet', gig: 'GigabitEthernet', giga: 'GigabitEthernet', gigabitethernet: 'GigabitEthernet',
  te: 'TenGigabitEthernet', tengigabitethernet: 'TenGigabitEthernet',
  eth: 'Ethernet', ethernet: 'Ethernet',
};

function arpSummary(entries: Array<[string, CiscoARPEntry]>): string {
  const total = entries.length;
  const dyn = entries.filter(([, e]) => e.type === 'dynamic').length;
  const stat = entries.filter(([, e]) => e.type === 'static').length;
  return [
    `Total number of entries in the arp table: ${total}.`,
    `Total number of Dynamic entries: ${dyn}.`,
    `Total number of Static entries: ${stat}.`,
    `Total number of Interface entries: ${total - dyn - stat}.`,
  ].join('\n');
}

function arpCount(entries: Array<[string, CiscoARPEntry]>): string {
  return `Total number of entries in the arp table: ${entries.length}.`;
}

function arpDetail(entries: Array<[string, CiscoARPEntry]>): string {
  if (entries.length === 0) return 'No ARP entries.';
  const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface   VRF'];
  for (const [ip, entry] of entries) {
    const isStatic = entry.type === 'static';
    const age = isStatic ? '-' : String(Math.floor((Date.now() - entry.timestamp) / 60000));
    lines.push(
      `Internet  ${ip.padEnd(17)}${age.padEnd(12)}${entry.mac.toCiscoString().padEnd(18)}` +
      `${(isStatic ? 'static' : 'ARPA').padEnd(7)}${entry.iface.padEnd(12)}Default`,
    );
  }
  return lines.join('\n');
}

function matchArpInterface(provider: ARPProvider, raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, '').toLowerCase();
  const ports = provider._getPortsInternal();
  for (const name of ports.keys()) {
    if (name.toLowerCase() === collapsed) return name;
  }
  const m = collapsed.match(/^([a-z]+)([\d/.]+)$/);
  if (!m) return null;
  const full = ARP_IFACE_PREFIXES[m[1]];
  if (!full) return null;
  const resolved = `${full}${m[2]}`.toLowerCase();
  for (const name of ports.keys()) {
    if (name.toLowerCase() === resolved) return name;
  }
  return null;
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
    if (/^summary$/i.test(filter)) return arpSummary(entries);
    if (/^count$/i.test(filter)) return arpCount(entries);
    if (/^detail$/i.test(filter)) return arpDetail(entries);
    if (/^statistics$/i.test(filter)) {
      return "% Invalid input detected at '^' marker.";
    }
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(filter);
    const vlanMatch = /^vlan\s*(\d+)$/i.exec(filter);
    if (isIP) {
      entries = entries.filter(([ip]) => ip === filter);
    } else if (vlanMatch) {
      const vlanId = parseInt(vlanMatch[1], 10);
      const sviIds = provider._getSviVlanIds?.();
      if (!sviIds || !sviIds.includes(vlanId)) return '% Invalid interface';
      entries = entries.filter(([, entry]) => entry.iface === `Vlan${vlanId}`);
    } else {
      const canonical = matchArpInterface(provider, filter);
      if (!canonical) return "% Invalid input detected at '^' marker.";
      entries = entries.filter(([, entry]) => entry.iface === canonical);
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
    lines.push(`Internet  ${ip.padEnd(17)}${age.padEnd(12)}${entry.mac.toCiscoString().padEnd(18)}${suffix}`);
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
    let ip: IPAddress;
    try { ip = new IPAddress(args[0]); }
    catch { return `% Invalid IP address "${args[0]}"`; }
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
    let ip: IPAddress;
    try { ip = new IPAddress(args[0]); }
    catch { return `% Invalid IP address "${args[0]}"`; }
    getProvider()._deleteARP(ip);
    return '';
  });
}
