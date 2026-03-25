/**
 * Linux `arp` command implementation — display and manipulate the ARP cache.
 *
 * Mimics the real net-tools `arp` utility:
 *   arp             — show all entries (BSD-style, same as arp -a)
 *   arp -a [ip]     — display entries (BSD-style "? (IP) at MAC [ether] on IFACE")
 *   arp -n          — numeric, no name resolution (tabular format)
 *   arp -e          — Linux tabular format (Address / HWtype / HWaddress / Flags / Mask / Iface)
 *   arp -d <ip>     — delete entry
 *   arp -s <ip> <mac> — add static entry
 *   arp -i <iface>  — filter by interface
 *   arp --help      — usage
 *   arp -V          — version
 *
 * Flags can be combined: arp -an, arp -en, arp -ani eth0, etc.
 */

import type { ARPEntry } from '../EndHost';
import { MACAddress } from '../../core/types';

export interface LinuxArpContext {
  /** ARP table: IP string → ARPEntry */
  arpTable: Map<string, ARPEntry>;
  /** Add a static ARP entry */
  addStaticARP(ip: string, mac: MACAddress, iface: string): void;
  /** Delete an ARP entry by IP. Returns true if deleted. */
  deleteARP(ip: string): boolean;
  /** Default interface name (first port) */
  defaultIface: string;
}

// ─── Flags parsing ─────────────────────────────────────────────────

interface ArpFlags {
  show: boolean;         // -a or default
  numeric: boolean;      // -n
  tabular: boolean;      // -e
  delete: boolean;       // -d
  addStatic: boolean;    // -s
  help: boolean;         // --help
  version: boolean;      // -V
  filterIface: string | null;  // -i <iface>
  filterIP: string | null;     // positional IP for -a <ip> or -d <ip>
  staticMAC: string | null;    // positional MAC for -s <ip> <mac>
}

function parseFlags(args: string[]): ArpFlags {
  const flags: ArpFlags = {
    show: false,
    numeric: false,
    tabular: false,
    delete: false,
    addStatic: false,
    help: false,
    version: false,
    filterIface: null,
    filterIP: null,
    staticMAC: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help') {
      flags.help = true;
      i++;
    } else if (arg === '-V' || arg === '--version') {
      flags.version = true;
      i++;
    } else if (arg === '-d') {
      flags.delete = true;
      // Next arg is the IP
      if (i + 1 < args.length) {
        flags.filterIP = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (arg === '-s') {
      flags.addStatic = true;
      // Next two args: IP and MAC
      if (i + 1 < args.length) flags.filterIP = args[i + 1];
      if (i + 2 < args.length) flags.staticMAC = args[i + 2];
      i += 3;
    } else if (arg === '-i') {
      // Next arg is the interface name
      if (i + 1 < args.length) {
        flags.filterIface = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (arg.startsWith('-') && arg !== '-a') {
      // Combined flags like -an, -en, -ane
      for (const ch of arg.slice(1)) {
        switch (ch) {
          case 'a': flags.show = true; break;
          case 'n': flags.numeric = true; break;
          case 'e': flags.tabular = true; break;
          case 'i':
            // -i needs the next argument
            if (i + 1 < args.length) {
              flags.filterIface = args[i + 1];
              i++;
            }
            break;
          default:
            break;
        }
      }
      i++;
    } else if (arg === '-a') {
      flags.show = true;
      // Check if next arg is an IP (not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.filterIP = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else {
      // Positional argument: treat as IP filter if show mode
      if (!flags.filterIP) {
        flags.filterIP = arg;
      }
      i++;
    }
  }

  return flags;
}

// ─── Help text ─────────────────────────────────────────────────────

const HELP_TEXT = `Usage:
  arp [-vn]  [<HW>] [-i <if>] [-a] [<hostname>]             <-Display ARP cache
  arp [-v]          [-i <if>] -d  <hostname> [pub]           <-Delete ARP entry
  arp [-v]   [<HW>] [-i <if>] -s  <hostname> <hwaddr> [temp]<-Add entry
  arp [-v]   [<HW>] [-i <if>] -Ds <hostname> <if> [netmask <nm>] pub          <-''-

        -a                       display (all) hosts in alternative (BSD) style
        -e                       display (all) hosts in default (Linux) style
        -s, --set                set a new ARP entry
        -d, --delete             delete a specified entry
        -v, --verbose            be verbose
        -n, --numeric            don't resolve names
        -i, --device             specify network interface (e.g. eth0)
        -D, --use-device         read <hwaddr> from given device
        -A, -p, --protocol       specify protocol family
        -f, --file               read new entries from file or from /etc/ethers

  <HW>=Use '-H <hw>' to specify hardware address type. Default: ether
  List of possible hardware types (which support ARP):
    ash (Ash) ether (Ethernet) ax25 (AMPR AX.25)
    netrom (AMPR NET/ROM) rose (AMPR ROSE) arcnet (ARCnet)
    dlci (Frame Relay DLCI) fddi (Fiber Distributed Data Interface) hippi (HIPPI)
    irda (IrLAP) x25 (generic X.25) eui64 (Generic EUI-64)`;

const VERSION_TEXT = 'net-tools 2.10-alpha';

// ─── Display formatters ────────────────────────────────────────────

function formatBSD(entries: [string, ARPEntry][]): string {
  if (entries.length === 0) return '';
  return entries
    .map(([ip, e]) => `? (${ip}) at ${e.mac} [ether] on ${e.iface}`)
    .join('\n');
}

function formatTabular(entries: [string, ARPEntry][]): string {
  if (entries.length === 0) return '';

  const header = 'Address                  HWtype  HWaddress           Flags Mask            Iface';
  const lines = [header];
  for (const [ip, entry] of entries) {
    const flags = entry.type === 'static' ? 'CM' : 'C';
    lines.push(
      `${ip.padEnd(25)}ether   ${entry.mac.toString().padEnd(20)}${flags.padEnd(6)}${'*'.padEnd(16)}${entry.iface}`,
    );
  }
  return lines.join('\n');
}

// ─── Main command entry point ──────────────────────────────────────

export function linuxArp(ctx: LinuxArpContext, args: string[]): string {
  const flags = parseFlags(args);

  // --help takes precedence
  if (flags.help) return HELP_TEXT;
  if (flags.version) return VERSION_TEXT;

  // ─── arp -d <ip> ─────────────────────────────────────────────
  if (flags.delete) {
    if (!flags.filterIP) {
      return HELP_TEXT;
    }
    const deleted = ctx.deleteARP(flags.filterIP);
    if (!deleted) {
      return `SIOCDARP(dontpub): No ARP entry for ${flags.filterIP}`;
    }
    return '';
  }

  // ─── arp -s <ip> <mac> ──────────────────────────────────────
  if (flags.addStatic) {
    if (!flags.filterIP || !flags.staticMAC) {
      return HELP_TEXT;
    }
    let mac: MACAddress;
    try {
      mac = new MACAddress(flags.staticMAC);
    } catch {
      return `arp: invalid hardware address: ${flags.staticMAC}`;
    }
    const iface = flags.filterIface || ctx.defaultIface;
    ctx.addStaticARP(flags.filterIP, mac, iface);
    return '';
  }

  // ─── Display mode (default) ──────────────────────────────────
  let entries = Array.from(ctx.arpTable.entries());

  // Filter by IP
  if (flags.filterIP) {
    entries = entries.filter(([ip]) => ip === flags.filterIP);
  }

  // Filter by interface
  if (flags.filterIface) {
    entries = entries.filter(([, e]) => e.iface === flags.filterIface);
  }

  if (entries.length === 0) return '';

  // -n or -e forces tabular format
  if (flags.numeric || flags.tabular) {
    return formatTabular(entries);
  }

  // Default: BSD format
  return formatBSD(entries);
}
