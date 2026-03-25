/**
 * Windows ARP command — display and modify the ARP cache.
 *
 * Supported:
 *   arp -a [inet_addr] [-N if_addr] [-v]  — display ARP table
 *   arp -g [inet_addr] [-N if_addr] [-v]  — same as -a
 *   arp -d inet_addr [if_addr]            — delete entry (* = all)
 *   arp -s inet_addr eth_addr [if_addr]   — add static entry
 *   arp /?                                — usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { MACAddress } from '../../core/types';

const ARP_HELP = `
Displays and modifies the IP-to-Physical address translation tables used by
address resolution protocol (ARP).

ARP -s inet_addr eth_addr [if_addr]
ARP -d inet_addr [if_addr]
ARP -a [inet_addr] [-N if_addr] [-v]

  -a            Displays current ARP entries by interrogating the current
                protocol data.  If inet_addr is specified, the IP and Physical
                addresses for only the specified computer are displayed.  If
                more than one network interface uses ARP, entries for each ARP
                table are displayed.
  -g            Same as -a.
  -v            Displays current ARP entries in verbose mode.  All invalid
                entries and entries on the loop-back interface will be shown.
  inet_addr     Specifies an internet address.
  -N if_addr    Displays the ARP entries for the network interface specified
                by if_addr.
  -d            Deletes the host specified by inet_addr. inet_addr may be
                wildcarded with * to delete all hosts.
  -s            Adds the host and associates the Internet address inet_addr
                with the Physical address eth_addr.  The Physical address is
                given as 6 hexadecimal bytes separated by hyphens. The entry
                is permanent.
  eth_addr      Specifies a physical address.
  if_addr       If present, this specifies the Internet address of the
                interface whose address translation table should be modified.
                If not present, the first applicable interface will be used.
Example:
  > arp -s 157.55.85.212   00-aa-00-62-c6-09  .... Adds a static entry.
  > arp -a                                     .... Displays the arp table.`.trim();

// ─── Argument parsing ──────────────────────────────────────────────

interface WinArpFlags {
  mode: 'show' | 'delete' | 'add' | 'help';
  filterIP: string | null;
  filterIfaceIP: string | null;  // -N value
  staticMAC: string | null;
  verbose: boolean;
}

function parseArgs(args: string[]): WinArpFlags {
  const flags: WinArpFlags = {
    mode: 'show',
    filterIP: null,
    filterIfaceIP: null,
    staticMAC: null,
    verbose: false,
  };

  if (args.includes('/?') || args.includes('/help')) {
    flags.mode = 'help';
    return flags;
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '-a' || arg === '-g') {
      flags.mode = 'show';
      // Next arg might be an IP (not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.filterIP = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (arg === '-v') {
      flags.verbose = true;
      i++;
    } else if (arg === '-N') {
      if (i + 1 < args.length) {
        flags.filterIfaceIP = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (arg === '-d') {
      flags.mode = 'delete';
      if (i + 1 < args.length) {
        flags.filterIP = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (arg === '-s') {
      flags.mode = 'add';
      if (i + 1 < args.length) flags.filterIP = args[i + 1];
      if (i + 2 < args.length) flags.staticMAC = args[i + 2];
      i += 3;
    } else {
      i++;
    }
  }

  // No flags at all → default to show
  if (args.length === 0) flags.mode = 'show';

  return flags;
}

// ─── Main entry point ──────────────────────────────────────────────

export function cmdArp(ctx: WinCommandContext, args: string[]): string {
  const flags = parseArgs(args);

  switch (flags.mode) {
    case 'help':
      return ARP_HELP;

    case 'delete':
      return handleDelete(ctx, flags);

    case 'add':
      return handleAdd(ctx, flags);

    case 'show':
    default:
      return handleShow(ctx, flags);
  }
}

// ─── Show ──────────────────────────────────────────────────────────

function handleShow(ctx: WinCommandContext, flags: WinArpFlags): string {
  // Collect and filter entries
  let entries = Array.from(ctx.arpTable.entries());

  // Filter by specific IP
  if (flags.filterIP) {
    entries = entries.filter(([ip]) => ip === flags.filterIP);
  }

  // Filter by interface IP (-N)
  if (flags.filterIfaceIP) {
    entries = entries.filter(([, entry]) => {
      const port = ctx.ports.get(entry.iface);
      const ifaceIP = port?.getIPAddress()?.toString();
      return ifaceIP === flags.filterIfaceIP;
    });
  }

  if (entries.length === 0) return 'No ARP Entries Found.';

  // Group by interface
  const byIface = new Map<string, Array<{ ip: string; mac: string; type: string }>>();
  for (const [ip, entry] of entries) {
    const iface = entry.iface;
    if (!byIface.has(iface)) byIface.set(iface, []);
    const macStr = entry.mac.toString().replace(/:/g, '-');
    const entryType = entry.type === 'static' ? 'static' : 'dynamic';
    byIface.get(iface)!.push({ ip, mac: macStr, type: entryType });
  }

  const lines: string[] = [];
  for (const [iface, ifEntries] of byIface) {
    const port = ctx.ports.get(iface);
    const ifaceIP = port?.getIPAddress()?.toString() || iface;
    const ifaceIdx = parseInt(iface.replace(/\D/g, '') || '0', 10) + 1;
    lines.push('');
    lines.push(`Interface: ${ifaceIP} --- 0x${ifaceIdx}`);
    lines.push('  Internet Address      Physical Address      Type');
    for (const e of ifEntries) {
      lines.push(`  ${e.ip.padEnd(22)}${e.mac.padEnd(22)}${e.type}`);
    }
  }
  return lines.join('\n');
}

// ─── Delete ────────────────────────────────────────────────────────

function handleDelete(ctx: WinCommandContext, flags: WinArpFlags): string {
  if (!flags.filterIP) return ARP_HELP;

  if (flags.filterIP === '*') {
    ctx.clearARPTable();
    return '';
  }

  ctx.deleteARP(flags.filterIP);
  // Windows silently accepts even if entry didn't exist
  return '';
}

// ─── Add static ────────────────────────────────────────────────────

function handleAdd(ctx: WinCommandContext, flags: WinArpFlags): string {
  if (!flags.filterIP || !flags.staticMAC) return ARP_HELP;

  let mac: MACAddress;
  try {
    mac = new MACAddress(flags.staticMAC);
  } catch {
    return ARP_HELP;
  }

  // Determine the interface: use the first port with an IP
  let iface = '';
  for (const [name, port] of ctx.ports) {
    if (port.getIPAddress()) {
      iface = name;
      break;
    }
  }
  if (!iface && ctx.ports.size > 0) {
    iface = ctx.ports.keys().next().value!;
  }

  ctx.addStaticARP(flags.filterIP, mac, iface);
  return '';
}
