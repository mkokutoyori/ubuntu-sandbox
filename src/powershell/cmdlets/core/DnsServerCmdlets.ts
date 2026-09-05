/**
 * DnsServerCmdlets — the `DnsServer` PowerShell module (PRD-Windows-
 * Server.md §5 P7): Add-DnsServerPrimaryZone, Add-DnsServerResourceRecordA/
 * AAAA/CName/Mx/Ptr, Add-DnsServerResourceRecord -Srv, Remove-
 * DnsServerResourceRecord, Get-DnsServerZone, Get-DnsServerResourceRecord,
 * Set-DnsServerForwarder/Get-DnsServerForwarder.
 *
 * Provider: ctx.providers.dns (IDnsServerProvider), populated only for a
 * `WindowsServer` device with the DNS role installed — see
 * `WindowsDnsServerAdapter`.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDnsServerProvider, DnsZoneInfo, DnsRecordInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireDns(ctx: CmdletContext, cmdletName: string): IDnsServerProvider {
  if (!ctx.providers.dns) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.dns;
}

function zoneToPSObject(z: DnsZoneInfo): Record<string, PSValue> {
  return {
    ZoneName: z.name, ZoneType: 'Primary', RecordCount: z.recordCount,
    DynamicUpdate: z.dynamicUpdate, IsDsIntegrated: true,
  };
}
function recordToPSObject(r: DnsRecordInfo): Record<string, PSValue> {
  return { HostName: r.name, RecordType: r.type, TimeToLive: r.ttl, RecordData: r.text };
}
function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}
function zoneNameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['zonename'] ?? '');
}
function ttlOf(ctx: CmdletContext): number | undefined {
  return ctx.named['timetolive'] !== undefined ? Number(psValueToString(ctx.named['timetolive'])) : undefined;
}

// ── Zones ────────────────────────────────────────────────────────────────

export class AddDnsServerPrimaryZoneCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverprimaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneFile', 'ResponsiblePerson'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerPrimaryZone');
    const name = nameOf(ctx);
    if (!name) { ctx.emitError('Add-DnsServerPrimaryZone : Cannot process command because of one or more missing mandatory parameters: Name.'); return null; }
    const adminEmail = ctx.named['responsibleperson'] !== undefined ? psValueToString(ctx.named['responsibleperson']) : undefined;
    const res = dns.addPrimaryZone(name, adminEmail);
    if (!res.ok) { ctx.emitError(`Add-DnsServerPrimaryZone : ${res.message}`); return null; }
    return null;
  }
}

export class GetDnsServerZoneCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerZone');
    const name = nameOf(ctx);
    if (name) {
      const z = dns.getZone(name);
      if (!z) { ctx.emitError(`Get-DnsServerZone : Cannot find zone "${name}" on this server.`); return null; }
      return zoneToPSObject(z);
    }
    return dns.listZones().map(zoneToPSObject);
  }
}

const DYNAMIC_UPDATE_MODES = ['None', 'NonsecureAndSecure', 'Secure'] as const;

export class SetDnsServerPrimaryZoneCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverprimaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'DynamicUpdate'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerPrimaryZone');
    const name = nameOf(ctx);
    if (!name) {
      ctx.emitError('Set-DnsServerPrimaryZone : Cannot process command because of one or more missing mandatory parameters: Name.');
      return null;
    }
    const wanted = psValueToString(ctx.named['dynamicupdate'] ?? '');
    const mode = DYNAMIC_UPDATE_MODES.find(m => m.toLowerCase() === wanted.toLowerCase());
    if (!mode) {
      ctx.emitError(`Set-DnsServerPrimaryZone : Cannot validate argument on parameter 'DynamicUpdate'. The argument "${wanted}" does not belong to the set "${DYNAMIC_UPDATE_MODES.join(',')}".`);
      return null;
    }
    const res = dns.setZoneDynamicUpdate(name, mode);
    if (!res.ok) { ctx.emitError(`Set-DnsServerPrimaryZone : ${res.message}`); return null; }
    return null;
  }
}

export class AddDnsServerTsigKeyCmdlet implements ICmdlet {
  readonly name = 'add-dnsservertsigkey';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Algorithm', 'Secret'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerTsigKey');
    const name = nameOf(ctx);
    const algorithm = psValueToString(ctx.named['algorithm'] ?? 'hmac-sha256.');
    const secret = psValueToString(ctx.named['secret'] ?? '');
    if (!name || !secret) {
      ctx.emitError('Add-DnsServerTsigKey : Cannot process command because of one or more missing mandatory parameters: Name Secret.');
      return null;
    }
    const res = dns.addTsigKey(name, algorithm, secret);
    if (!res.ok) { ctx.emitError(`Add-DnsServerTsigKey : ${res.message}`); return null; }
    return null;
  }
}

export class GetDnsServerTsigKeyCmdlet implements ICmdlet {
  readonly name = 'get-dnsservertsigkey';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerTsigKey');
    return dns.listTsigKeys().map(k => ({ Name: k.name, Algorithm: k.algorithm }));
  }
}

export class RemoveDnsServerTsigKeyCmdlet implements ICmdlet {
  readonly name = 'remove-dnsservertsigkey';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerTsigKey');
    const res = dns.removeTsigKey(nameOf(ctx));
    if (!res.ok) { ctx.emitError(`Remove-DnsServerTsigKey : ${res.message}`); return null; }
    return null;
  }
}

// ── Resource records ─────────────────────────────────────────────────────

export class AddDnsServerResourceRecordACmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecorda';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'IPv4Address', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordA');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ip = psValueToString(ctx.named['ipv4address'] ?? '');
    if (!zone || !name || !ip) { ctx.emitError('Add-DnsServerResourceRecordA : Cannot process command because of one or more missing mandatory parameters: ZoneName Name IPv4Address.'); return null; }
    const res = dns.addARecord(zone, name, ip, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecordA : ${res.message}`); return null; }
    return null;
  }
}

export class AddDnsServerResourceRecordAAAACmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordaaaa';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'IPv6Address', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordAAAA');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ip = psValueToString(ctx.named['ipv6address'] ?? '');
    if (!zone || !name || !ip) { ctx.emitError('Add-DnsServerResourceRecordAAAA : Cannot process command because of one or more missing mandatory parameters: ZoneName Name IPv6Address.'); return null; }
    const res = dns.addAaaaRecord(zone, name, ip, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecordAAAA : ${res.message}`); return null; }
    return null;
  }
}

export class AddDnsServerResourceRecordCNameCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordcname';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'HostNameAlias', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordCName');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const alias = psValueToString(ctx.named['hostnamealias'] ?? '');
    if (!zone || !name || !alias) { ctx.emitError('Add-DnsServerResourceRecordCName : Cannot process command because of one or more missing mandatory parameters: ZoneName Name HostNameAlias.'); return null; }
    const res = dns.addCnameRecord(zone, name, alias, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecordCName : ${res.message}`); return null; }
    return null;
  }
}

export class AddDnsServerResourceRecordMXCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordmx';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'MailExchange', 'Preference', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordMX');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const exchange = psValueToString(ctx.named['mailexchange'] ?? '');
    const preference = ctx.named['preference'] !== undefined ? Number(psValueToString(ctx.named['preference'])) : 10;
    if (!zone || !name || !exchange) { ctx.emitError('Add-DnsServerResourceRecordMX : Cannot process command because of one or more missing mandatory parameters: ZoneName Name MailExchange.'); return null; }
    const res = dns.addMxRecord(zone, name, preference, exchange, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecordMX : ${res.message}`); return null; }
    return null;
  }
}

export class AddDnsServerResourceRecordPtrCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordptr';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'PtrDomainName', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordPtr');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ptr = psValueToString(ctx.named['ptrdomainname'] ?? '');
    if (!zone || !name || !ptr) { ctx.emitError('Add-DnsServerResourceRecordPtr : Cannot process command because of one or more missing mandatory parameters: ZoneName Name PtrDomainName.'); return null; }
    const res = dns.addPtrRecord(zone, name, ptr, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecordPtr : ${res.message}`); return null; }
    return null;
  }
}

/** Real Windows has no dedicated `Add-DnsServerResourceRecordSrv` — SRV records go through the generic cmdlet with a `-Srv` switch. */
export class AddDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'Srv', 'Priority', 'Weight', 'Port', 'DomainNameTarget', 'TimeToLive'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecord');
    if (ctx.named['srv'] !== true) {
      ctx.emitError('Add-DnsServerResourceRecord : only -Srv records are supported by this cmdlet; use the dedicated A/AAAA/CName/MX/Ptr cmdlets for other types.');
      return null;
    }
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const target = psValueToString(ctx.named['domainnametarget'] ?? '');
    const priority = ctx.named['priority'] !== undefined ? Number(psValueToString(ctx.named['priority'])) : 0;
    const weight = ctx.named['weight'] !== undefined ? Number(psValueToString(ctx.named['weight'])) : 0;
    const port = ctx.named['port'] !== undefined ? Number(psValueToString(ctx.named['port'])) : 0;
    if (!zone || !name || !target) { ctx.emitError('Add-DnsServerResourceRecord : Cannot process command because of one or more missing mandatory parameters: ZoneName Name DomainNameTarget.'); return null; }
    const res = dns.addSrvRecord(zone, name, { priority, weight, port, target }, ttlOf(ctx));
    if (!res.ok) { ctx.emitError(`Add-DnsServerResourceRecord : ${res.message}`); return null; }
    return null;
  }
}

export class RemoveDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'RRType', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerResourceRecord');
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const type = psValueToString(ctx.named['rrtype'] ?? '');
    if (!zone || !name || !type) { ctx.emitError('Remove-DnsServerResourceRecord : Cannot process command because of one or more missing mandatory parameters: ZoneName Name RRType.'); return null; }
    const res = dns.removeRecord(zone, name, type);
    if (!res.ok) { ctx.emitError(`Remove-DnsServerResourceRecord : ${res.message}`); return null; }
    return null;
  }
}

export class GetDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerResourceRecord');
    const zone = zoneNameOf(ctx);
    if (!zone) { ctx.emitError('Get-DnsServerResourceRecord : Cannot process command because of one or more missing mandatory parameters: ZoneName.'); return null; }
    const name = ctx.named['name'] !== undefined ? psValueToString(ctx.named['name']) : undefined;
    const records = dns.getRecords(zone, name);
    if (!records) { ctx.emitError(`Get-DnsServerResourceRecord : Cannot find zone "${zone}" on this server.`); return null; }
    return records.map(recordToPSObject);
  }
}

// ── Forwarders ───────────────────────────────────────────────────────────

export class SetDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = ['IPAddress'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerForwarder');
    const raw = ctx.named['ipaddress'] ?? ctx.positional;
    const addresses = Array.isArray(raw) ? raw.map(psValueToString) : [psValueToString(raw)];
    const res = dns.setForwarders(addresses.filter(a => a !== ''));
    if (!res.ok) { ctx.emitError(`Set-DnsServerForwarder : ${res.message}`); return null; }
    return null;
  }
}

export class GetDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerForwarder');
    return { IPAddress: dns.getForwarders().join(', ') };
  }
}
