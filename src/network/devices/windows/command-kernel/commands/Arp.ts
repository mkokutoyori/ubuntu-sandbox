import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { IPAddress, MACAddress } from '@/network/core/types';

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

interface ArpFlags {
  mode: 'show' | 'delete' | 'add' | 'help';
  filterIP: string | null;
  filterIfaceIP: string | null;
  staticMAC: string | null;
  staticIfAddr: string | null;
  verbose: boolean;
}

function parseArpArgs(args: string[]): ArpFlags {
  const flags: ArpFlags = {
    mode: 'show',
    filterIP: null,
    filterIfaceIP: null,
    staticMAC: null,
    staticIfAddr: null,
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
      if (i + 3 < args.length && !args[i + 3].startsWith('-')) flags.staticIfAddr = args[i + 3];
      i += 4;
    } else {
      i++;
    }
  }

  if (args.length === 0) flags.mode = 'show';

  return flags;
}

export class ArpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arp',
    summary: 'Affiche et modifie la table ARP',
    usage: ARP_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options arp' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    // `arp` utilise des options style BSD (`-a`, `-d`, `-s`...), pas le `/flag`
    // habituel de cmd.exe — elles doivent atterrir en positionnels bruts pour
    // que `parseArpArgs` fasse elle-même le dispatch, comme le vrai arp.exe.
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('ARP: not supported on this device\n');
      return 1;
    }

    const flags = parseArpArgs(args);
    let out: string;
    switch (flags.mode) {
      case 'help': out = ARP_HELP; break;
      case 'delete': out = this.handleDelete(ctx, flags); break;
      case 'add': out = this.handleAdd(ctx, flags); break;
      case 'show':
      default: out = this.handleShow(ctx, flags); break;
    }
    if (out) await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }

  private handleShow(ctx: CommandContext, flags: ArpFlags): string {
    const netConfig = ctx.machine.netConfig!;
    let entries = netConfig.arpEntries();

    if (flags.filterIP) {
      entries = entries.filter((e) => e.ip === flags.filterIP);
    }

    if (flags.filterIfaceIP) {
      const adapters = netConfig.adapters();
      entries = entries.filter((e) => {
        const adapter = adapters.find((a) => a.name === e.iface);
        return adapter?.ip === flags.filterIfaceIP;
      });
    }

    if (entries.length === 0) return 'No ARP Entries Found.';

    const byIface = new Map<string, Array<{ ip: string; mac: string; type: string }>>();
    for (const e of entries) {
      if (!byIface.has(e.iface)) byIface.set(e.iface, []);
      const macStr = e.mac.replace(/:/g, '-');
      const entryType = e.type === 'static' ? 'static' : 'dynamic';
      byIface.get(e.iface)!.push({ ip: e.ip, mac: macStr, type: entryType });
    }

    const adapters = netConfig.adapters();
    const lines: string[] = [];
    for (const [iface, ifEntries] of byIface) {
      const adapter = adapters.find((a) => a.name === iface);
      const ifaceIP = adapter?.ip || iface;
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

  private handleDelete(ctx: CommandContext, flags: ArpFlags): string {
    if (!flags.filterIP) return ARP_HELP;

    if (flags.filterIP === '*') {
      ctx.machine.netConfig!.clearArp();
      return '';
    }

    let ip: IPAddress;
    try { ip = new IPAddress(flags.filterIP); }
    catch { return ARP_HELP; }
    ctx.machine.netConfig!.deleteArp(ip.toString());
    // Windows silently accepts even if the entry didn't exist.
    return '';
  }

  private handleAdd(ctx: CommandContext, flags: ArpFlags): string {
    if (!flags.filterIP || !flags.staticMAC) return ARP_HELP;

    let mac: MACAddress;
    try {
      mac = new MACAddress(flags.staticMAC);
    } catch {
      return ARP_HELP;
    }

    const adapters = ctx.machine.netConfig!.adapters();
    let iface = '';
    if (flags.staticIfAddr) {
      const match = adapters.find((a) => a.ip === flags.staticIfAddr);
      if (!match) return 'The parameter is incorrect.';
      iface = match.name;
    } else {
      const withIp = adapters.find((a) => a.ip);
      iface = withIp ? withIp.name : (adapters[0]?.name ?? '');
    }

    let ip: IPAddress;
    try { ip = new IPAddress(flags.filterIP); }
    catch { return ARP_HELP; }

    const result = ctx.machine.netConfig!.addStaticArp(ip.toString(), mac.toString(), iface);
    if (!result.ok) return result.error ?? ARP_HELP;
    return '';
  }
}
