/**
 * Windows ARP command — display and modify the ARP cache.
 *
 * Supported:
 *   arp -a                — display ARP table
 *   arp -g                — same as -a
 *   arp -d <ip>           — delete entry (stub)
 *   arp /?                — usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';

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

export function cmdArp(ctx: WinCommandContext, args: string[]): string {
  if (args.includes('/?') || args.includes('/help')) {
    return ARP_HELP;
  }

  if (args.length === 0 || args[0] === '-a' || args[0] === '-g') {
    return showArpTable(ctx);
  }

  if (args[0] === '-d') {
    return ''; // Delete stub - silently accept
  }

  return ARP_HELP;
}

function showArpTable(ctx: WinCommandContext): string {
  if (ctx.arpTable.size === 0) return 'No ARP Entries Found.';

  // Group by interface
  const lines: string[] = [];
  const byIface = new Map<string, Array<{ ip: string; mac: string }>>();

  for (const [ip, entry] of ctx.arpTable) {
    const iface = entry.iface;
    if (!byIface.has(iface)) byIface.set(iface, []);
    byIface.get(iface)!.push({ ip, mac: entry.mac.toString().replace(/:/g, '-') });
  }

  for (const [iface, entries] of byIface) {
    const port = ctx.ports.get(iface);
    const ifaceIP = port?.getIPAddress()?.toString() || iface;
    lines.push('');
    lines.push(`Interface: ${ifaceIP} --- 0x${parseInt(iface.replace('eth', '')) + 1}`);
    lines.push('  Internet Address      Physical Address      Type');
    for (const e of entries) {
      lines.push(`  ${e.ip.padEnd(22)}${e.mac.padEnd(22)}dynamic`);
    }
  }
  return lines.join('\n');
}
