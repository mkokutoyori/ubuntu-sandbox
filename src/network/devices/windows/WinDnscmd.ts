/**
 * `dnscmd` — the classic cmd-line DNS Server administration tool
 * (PRD-Windows-Server.md §5 P7, "formes usuelles"). Thin syntax shim over
 * the same `IDnsServerProvider`/`WindowsDnsServerRole` surface the
 * `DnsServer` PowerShell module uses — real usual forms only:
 *
 *   dnscmd [ServerName] /ZoneAdd <Zone> /Primary
 *   dnscmd [ServerName] /RecordAdd <Zone> <Node> <A|AAAA|CNAME|MX|PTR|SRV> <data...>
 *   dnscmd [ServerName] /RecordDelete <Zone> <Node> <RRType> [/f]
 *   dnscmd [ServerName] /ZonePrint <Zone>
 *   dnscmd [ServerName] /EnumZones
 *   dnscmd [ServerName] /ResetForwarders <IP> [IP...]
 */

import type { WindowsDnsServerRole } from './server/dns/WindowsDnsServerRole';

export interface DnscmdContext {
  dns: WindowsDnsServerRole | null;
}

function stripServerName(args: string[]): string[] {
  return args.length > 0 && !args[0].startsWith('/') ? args.slice(1) : args;
}

export function cmdDnscmd(ctx: DnscmdContext, rawArgs: string[]): string {
  if (!ctx.dns) {
    return "'dnscmd' is not recognized as an internal or external command,\noperable program or batch file.";
  }
  const args = stripServerName(rawArgs);
  if (args.length === 0) {
    return 'Usage: dnscmd [ServerName] <Command> <Command Parameters>';
  }
  const command = args[0].toLowerCase();
  const rest = args.slice(1);

  switch (command) {
    case '/zoneadd': {
      const zone = rest[0];
      if (!zone) return 'DNS Server has encountered an error: missing zone name.\nCommand failed:\tstatus = 87\n';
      const res = ctx.dns.addPrimaryZone(zone);
      if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711\n`;
      return `Command completed successfully.\n`;
    }

    case '/recordadd': {
      const [zone, node, type, ...data] = rest;
      if (!zone || !node || !type) return 'Command failed:\tstatus = 87\n';
      const res = addRecord(ctx.dns, zone, node, type.toUpperCase(), data);
      if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711\n`;
      return `Command completed successfully.\n`;
    }

    case '/recorddelete': {
      const [zone, node, type] = rest;
      if (!zone || !node || !type) return 'Command failed:\tstatus = 87\n';
      const res = ctx.dns.removeRecord(zone, node, type.toUpperCase());
      if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 9711\n`;
      return `Command completed successfully.\n`;
    }

    case '/zoneprint': {
      const zone = rest[0];
      if (!zone) return 'Command failed:\tstatus = 87\n';
      const records = ctx.dns.getRecords(zone);
      if (!records) return `DNS Server has encountered an error: Zone "${zone}" does not exist on this server.\nCommand failed:\tstatus = 9714\n`;
      const lines = [`Zone ${zone} records:`, ...records.map(r => `${r.name.padEnd(40)}${String(r.ttl).padEnd(8)}${r.type.padEnd(8)}${r.text}`)];
      return lines.join('\n');
    }

    case '/enumzones': {
      const zones = ctx.dns.listZones();
      const lines = ['Enumerated zone list:', `\tTotal zones: ${zones.length}`, ...zones.map(z => ` ${z.name}`)];
      return lines.join('\n');
    }

    case '/resetforwarders': {
      const res = ctx.dns.setForwarders(rest);
      if (!res.ok) return `DNS Server has encountered an error: ${res.message}\nCommand failed:\tstatus = 87\n`;
      return `Command completed successfully.\n`;
    }

    default:
      return `Unknown command option ${args[0]}.\n\nType 'dnscmd /?' for a list of valid commands.`;
  }
}

function addRecord(dns: WindowsDnsServerRole, zone: string, node: string, type: string, data: string[]): { ok: boolean; message: string } {
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
