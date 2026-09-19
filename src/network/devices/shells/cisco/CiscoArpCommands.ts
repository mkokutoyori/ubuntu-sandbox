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
import { renderTableText } from '../cli/TextTable';
import {
  ARP_COLUMNS, ARP_DETAIL_COLUMNS, ARP_STYLE, type ArpRow,
} from './ciscoTableLayouts';

// Re-export for backward compatibility
export type { CiscoARPEntry, ARPProvider } from '../CiscoDevice';

const ARP_IFACE_PREFIXES: Record<string, string> = {
  fa: 'FastEthernet', fas: 'FastEthernet', fast: 'FastEthernet', fastethernet: 'FastEthernet',
  gi: 'GigabitEthernet', gig: 'GigabitEthernet', giga: 'GigabitEthernet', gigabitethernet: 'GigabitEthernet',
  te: 'TenGigabitEthernet', tengigabitethernet: 'TenGigabitEthernet',
  eth: 'Ethernet', ethernet: 'Ethernet',
};

const ARP_AGE_UNIT_MS = 60_000;
const ARP_NO_AGE = '-';
const ARP_ENCAPSULATION = 'ARPA';
const ARP_PROTOCOL = 'Internet';
const ARP_DEFAULT_VRF = 'Default';

type ArpKind = 'interface' | 'dynamic' | 'static';

interface ArpLine extends ArpRow { readonly kind: ArpKind; }

function interfaceLines(provider: ARPProvider): ArpLine[] {
  const out: ArpLine[] = [];
  for (const [name, port] of provider._getPortsInternal()) {
    const ip = port.getIPAddress();
    if (!ip) continue;
    out.push({
      protocol: ARP_PROTOCOL, address: ip.toString(), age: ARP_NO_AGE,
      mac: port.getMAC().toCiscoString(), type: ARP_ENCAPSULATION,
      iface: name, vrf: ARP_DEFAULT_VRF, kind: 'interface',
    });
  }
  return out;
}

function tableLine([ip, entry]: [string, CiscoARPEntry]): ArpLine {
  const isStatic = entry.type === 'static';
  return {
    protocol: ARP_PROTOCOL,
    address: ip,
    age: isStatic
      ? ARP_NO_AGE
      : String(Math.floor((Date.now() - entry.timestamp) / ARP_AGE_UNIT_MS)),
    mac: entry.mac.toCiscoString(),
    type: ARP_ENCAPSULATION,
    iface: entry.iface,
    vrf: ARP_DEFAULT_VRF,
    kind: isStatic ? 'static' : 'dynamic',
  };
}

function arpLines(
  provider: ARPProvider, entries: Array<[string, CiscoARPEntry]>,
): ArpLine[] {
  const own = interfaceLines(provider);
  const held = new Set(own.map(line => line.address));
  return [...own, ...entries.filter(([ip]) => !held.has(ip)).map(tableLine)];
}

function arpSummary(lines: readonly ArpLine[]): string {
  const count = (kind: ArpKind) => lines.filter(line => line.kind === kind).length;
  return [
    `Total number of entries in the arp table: ${lines.length}.`,
    `Total number of Dynamic entries: ${count('dynamic')}.`,
    `Total number of Static entries: ${count('static')}.`,
    `Total number of Interface entries: ${count('interface')}.`,
  ].join('\n');
}

function arpCount(lines: readonly ArpLine[]): string {
  return `Total number of entries in the arp table: ${lines.length}.`;
}

function arpDetail(lines: readonly ArpLine[]): string {
  if (lines.length === 0) return 'No ARP entries.';
  return renderTableText(lines, ARP_DETAIL_COLUMNS, ARP_STYLE);
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
  let lines = arpLines(provider, Array.from(arpTable.entries()));

  if (filterArgs && filterArgs.length > 0) {
    const filter = filterArgs.join(' ');
    if (/^summary$/i.test(filter)) return arpSummary(lines);
    if (/^count$/i.test(filter)) return arpCount(lines);
    if (/^detail$/i.test(filter)) return arpDetail(lines);
    if (/^statistics$/i.test(filter)) {
      return "% Invalid input detected at '^' marker.";
    }
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(filter);
    const vlanMatch = /^vlan\s*(\d+)$/i.exec(filter);
    if (isIP) {
      lines = lines.filter(line => line.address === filter);
    } else if (vlanMatch) {
      const vlanId = parseInt(vlanMatch[1], 10);
      const sviIds = provider._getSviVlanIds?.();
      if (!sviIds || !sviIds.includes(vlanId)) return '% Invalid interface';
      lines = lines.filter(line => line.iface === `Vlan${vlanId}`);
    } else {
      const canonical = matchArpInterface(provider, filter);
      if (!canonical) return "% Invalid input detected at '^' marker.";
      lines = lines.filter(line => line.iface === canonical);
    }
  }

  if (lines.length === 0) return 'No ARP entries.';
  return renderTableText(lines, ARP_COLUMNS, ARP_STYLE);
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
