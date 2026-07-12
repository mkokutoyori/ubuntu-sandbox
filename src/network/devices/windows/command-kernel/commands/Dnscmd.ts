import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { DnsServerAdminApi } from '@/command-kernel/machine/types';

const DNSCMD_HELP = `Usage: DnsCmd <ServerName> <Command> [<Command Parameters>]

<ServerName>:
  IP address or host name  -- remote or local DNS server
  .                        -- DNS server on local machine

<Command>:
  /Info                    -- Get server information
  /Config                  -- Reset server or zone configuration
  /EnumZones               -- Enumerate zones
  /Statistics              -- Query/clear server statistics data
  /ClearCache              -- Clear DNS server cache
  /WriteBackFiles          -- Write back all zone or root-hint datafile(s)
  /StartScavenging         -- Initiates server scavenging
  /ResetListenAddresses    -- Set server IP address(es) to serve DNS requests
  /ResetForwarders         -- Set DNS servers to forward recursive queries to
  /ZoneInfo                -- View zone information
  /ZoneAdd                 -- Create a new zone on the DNS server
  /ZoneDelete              -- Delete a zone from DNS server or DS
  /ZonePrint               -- Display all records in the zone
  /RecordAdd               -- Create a record in zone or RootHints
  /RecordDelete            -- Delete a record from zone, RootHints or cache

<Command Parameters>:
  DnsCmd <ServerName> /ZoneAdd <ZoneName> /Primary
  DnsCmd <ServerName> /RecordAdd <ZoneName> <NodeName> <RRType> <RRData>
  DnsCmd <ServerName> /RecordDelete <ZoneName> <NodeName> <RRType> [/f]
  DnsCmd <ServerName> /ZonePrint <ZoneName>
  DnsCmd <ServerName> /ResetForwarders <IPAddress> [<IPAddress>...]

<RRType>: A | AAAA | CNAME | MX | PTR | SRV`;

/**
 * `dnscmd` — administration en ligne de commande du serveur DNS. Fin shim
 * de syntaxe sur la même surface `DnsServerAdminApi` que le module
 * PowerShell `DnsServer`. Le parsing et le formatage sont portés par la
 * commande ; l'API n'est présente que lorsque le rôle DNS Server est
 * installé — sur un simple poste, `machine.dnsServer` est absent et la
 * commande répond « not recognized » (aucune fonctionnalité serveur exposée).
 */
export class DnscmdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dnscmd',
    summary: 'Administration en ligne de commande du serveur DNS',
    usage: DNSCMD_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '[ServerName] <commande> <paramètres>' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const rawArgs = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];

    // Le rôle DNS Server n'est pas installé (ou machine cliente) : `dnscmd`
    // n'existe tout simplement pas — même sortie que cmd.exe.
    const dns = ctx.machine.dnsServer;
    if (!dns) {
      await ctx.io.stdout.write("'dnscmd' is not recognized as an internal or external command,\noperable program or batch file.\n");
      return 1;
    }
    if (rawArgs.some((a) => a === '/?' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(DNSCMD_HELP + '\n');
      return EXIT_OK;
    }

    const args = this.stripServerName(rawArgs);
    if (args.length === 0) {
      await ctx.io.stdout.write('Usage: dnscmd [ServerName] <Command> <Command Parameters>\n');
      return 1;
    }

    const command = args[0].toLowerCase();
    const rest = args.slice(1);
    const out = this.dispatch(dns, command, rest, args[0]);
    await ctx.io.stdout.write(out + '\n');
    return out.includes('Command failed') || out.includes('Unknown command') ? 1 : EXIT_OK;
  }

  /** Le premier jeton, s'il ne commence pas par `/`, est le nom de serveur — ignoré (serveur local). */
  private stripServerName(args: string[]): string[] {
    return args.length > 0 && !args[0].startsWith('/') ? args.slice(1) : args;
  }

  private dispatch(dns: DnsServerAdminApi, command: string, rest: string[], raw: string): string {
    switch (command) {
      case '/zoneadd': {
        const zone = rest[0];
        if (!zone) return 'DNS Server has encountered an error: missing zone name.\nCommand failed:\tstatus = 87';
        const res = dns.addPrimaryZone(zone);
        if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711`;
        return 'Command completed successfully.';
      }
      case '/recordadd': {
        const [zone, node, type, ...data] = rest;
        if (!zone || !node || !type) return 'Command failed:\tstatus = 87';
        const res = this.addRecord(dns, zone, node, type.toUpperCase(), data);
        if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711`;
        return 'Command completed successfully.';
      }
      case '/recorddelete': {
        const [zone, node, type] = rest;
        if (!zone || !node || !type) return 'Command failed:\tstatus = 87';
        const res = dns.removeRecord(zone, node, type.toUpperCase());
        if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711`;
        return 'Command completed successfully.';
      }
      case '/zoneprint': {
        const zone = rest[0];
        if (!zone) return 'Command failed:\tstatus = 87';
        const records = dns.getRecords(zone);
        if (!records) return `DNS Server has encountered an error: Zone "${zone}" does not exist on this server.\nCommand failed:\tstatus = 9714`;
        const lines = [`Zone ${zone} records:`, ...records.map((r) => `${r.name.padEnd(40)}${String(r.ttl).padEnd(8)}${r.type.padEnd(8)}${r.text}`)];
        return lines.join('\n');
      }
      case '/enumzones': {
        const zones = dns.listZones();
        return ['Enumerated zone list:', `\tTotal zones: ${zones.length}`, ...zones.map((z) => ` ${z.name}`)].join('\n');
      }
      case '/resetforwarders': {
        const res = dns.setForwarders(rest);
        if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 87`;
        return 'Command completed successfully.';
      }
      default:
        return `Unknown command option ${raw}.\n\nType 'dnscmd /?' for a list of valid commands.`;
    }
  }

  private addRecord(dns: DnsServerAdminApi, zone: string, node: string, type: string, data: string[]): { ok: boolean; message: string } {
    switch (type) {
      case 'A': return dns.addARecord(zone, node, data[0] ?? '');
      case 'AAAA': return dns.addAaaaRecord(zone, node, data[0] ?? '');
      case 'CNAME': return dns.addCnameRecord(zone, node, data[0] ?? '');
      case 'PTR': return dns.addPtrRecord(zone, node, data[0] ?? '');
      case 'MX': return dns.addMxRecord(zone, node, Number(data[0] ?? 10), data[1] ?? '');
      case 'SRV': return dns.addSrvRecord(zone, node, {
        priority: Number(data[0] ?? 0), weight: Number(data[1] ?? 0), port: Number(data[2] ?? 0), target: data[3] ?? '',
      });
      default: return { ok: false, message: `Unsupported record type "${type}".` };
    }
  }
}
