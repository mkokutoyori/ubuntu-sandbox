import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type {
  IDnsServerProvider, DnsZoneInfo, DnsRecordInfo, DnsRecordSpec, DnsOpResult,
} from '@/powershell/providers/PSProviders';
import { psValueToString, registerPSDisplayFormatter } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';
import {
  DNS_TRANSFER_POLICIES, DNS_NOTIFY_POLICIES, formatRecordFields,
  type DnsTransferPolicy, type DnsNotifyPolicy, type DnsDynamicUpdateMode,
} from '@/network/devices/windows/server/dns/WindowsDnsServerRole';

function requireDns(ctx: CmdletContext, cmdletName: string): IDnsServerProvider {
  if (!ctx.providers.dns) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.dns;
}

const DYNAMIC_UPDATE_MODES: readonly DnsDynamicUpdateMode[] = ['None', 'NonsecureAndSecure', 'Secure'];
const REPLICATION_SCOPES = ['Domain', 'Forest', 'Legacy'] as const;

const LOCAL_TARGETS = ['.', 'localhost', '127.0.0.1', '::1'];

function guard(ctx: CmdletContext, cmdletName: string, dns: IDnsServerProvider): boolean {
  const raw = ctx.named['computername'];
  if (raw === undefined) return true;
  const target = psValueToString(Array.isArray(raw) ? raw[0] : raw).toLowerCase();
  const own = dns.serverName().toLowerCase();
  if (LOCAL_TARGETS.includes(target) || target === own || target.startsWith(`${own}.`)) return true;
  ctx.emitError(`${cmdletName} : Cannot reach "${target}": remote DNS Server management (CIM over WinRM) is not built, only the local server can be managed.`);
  return false;
}

function recordGuard(ctx: CmdletContext, cmdletName: string, dns: IDnsServerProvider): boolean {
  if (!guard(ctx, cmdletName, dns)) return false;
  for (const [key, name, reason] of [
    ['agerecord', 'AgeRecord', 'aging and scavenging are not modelled, so a record cannot be aged'],
    ['allowupdateany', 'AllowUpdateAny', 'per-record update permissions are not modelled, so a record cannot be opened to any updater'],
  ] as const) {
    if (isSwitchOn(ctx.named[key])) {
      ctx.emitError(`${cmdletName} : -${name} is refused: ${reason}.`);
      return false;
    }
  }
  return true;
}

function withPassThru(ctx: CmdletContext, dns: IDnsServerProvider, before: ReadonlySet<string>, name: string): PSValue {
  if (!isSwitchOn(ctx.named['passthru'])) return null;
  const zone = dns.getZone(name) ?? dns.listZones().find(z => !before.has(z.name));
  return zone ? zoneToPSObject(zone) : null;
}

function refuseUnbuilt(ctx: CmdletContext, cmdletName: string, checks: readonly (readonly [string, string, string])[]): boolean {
  for (const [key, label, reason] of checks) {
    if (ctx.named[key] !== undefined) {
      ctx.emitError(`${cmdletName} : -${label} is refused: ${reason}.`);
      return true;
    }
  }
  return false;
}

function recursionKept(ctx: CmdletContext, cmdletName: string): boolean {
  const raw = ctx.named['userecursion'];
  if (raw === undefined || isSwitchOn(raw)) return true;
  ctx.emitError(`${cmdletName} : -UseRecursion $false is refused: a conditional forwarder always asks its masters to recurse; the non-recursive mode is not built.`);
  return false;
}

function failed(ctx: CmdletContext, cmdletName: string, res: DnsOpResult): null {
  ctx.emitError(`${cmdletName} : ${res.message}`);
  return null;
}

function missing(ctx: CmdletContext, cmdletName: string, parameters: string): null {
  ctx.emitError(`${cmdletName} : Cannot process command because of one or more missing mandatory parameters: ${parameters}.`);
  return null;
}

function stringList(value: PSValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : psValueToString(value).split(',');
  return items.map(item => psValueToString(item).trim()).filter(item => item !== '');
}

function isSwitchOn(value: PSValue | undefined): boolean {
  return value === true || value === 1 || (typeof value === 'string' && ['true', '1'].includes(value.toLowerCase()));
}

function choice<T extends string>(
  ctx: CmdletContext, cmdletName: string, parameter: string, key: string, allowed: readonly T[],
): T | undefined | null {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  const wanted = psValueToString(raw);
  const found = allowed.find(value => value.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  ctx.emitError(`${cmdletName} : Cannot validate argument on parameter '${parameter}'. The argument "${wanted}" does not belong to the set "${allowed.join(',')}".`);
  return null;
}

function zoneToPSObject(z: DnsZoneInfo): Record<string, PSValue> {
  return {
    ZoneName: z.name, ZoneType: z.type, DynamicUpdate: z.dynamicUpdate,
    ReplicationScope: z.isDsIntegrated ? 'Domain' : 'None', IsDsIntegrated: z.isDsIntegrated,
    IsReverseLookupZone: z.isReverse, IsAutoCreated: false, IsPaused: !z.isLoaded && z.type === 'Secondary',
    IsReadOnly: z.type === 'Secondary', IsSigned: false, ZoneFile: z.zoneFile || null,
    MasterServers: z.masterServers, SecureSecondaries: z.secureSecondaries,
    SecondaryServers: z.secondaryServers, Notify: z.notify, NotifyServers: z.notifyServers,
    RecordCount: z.recordCount,
  };
}

const DNS_RECORD_DATA_TYPE = 'DnsServerRecordData';

registerPSDisplayFormatter(DNS_RECORD_DATA_TYPE, record =>
  formatRecordFields(psValueToString(record.__recordType), record as Record<string, string | number>) ?? '');

function recordData(type: string, data: Record<string, string | number>): Record<string, PSValue> {
  return { __type: DNS_RECORD_DATA_TYPE, __recordType: type, ...data };
}

function relativeName(fqdn: string, zone: string): string {
  const name = fqdn.toLowerCase();
  const origin = zone.toLowerCase();
  if (name === origin) return '@';
  return name.endsWith(`.${origin}`) ? name.slice(0, -origin.length - 1) : name;
}

function recordToPSObject(r: DnsRecordInfo, zone: string): Record<string, PSValue> {
  return {
    HostName: relativeName(r.name, zone), RecordType: r.type, TimeToLive: r.ttl,
    RecordData: recordData(r.type, r.data),
  };
}

function nameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

function zoneNameOf(ctx: CmdletContext): string {
  return psValueToString(ctx.named['zonename'] ?? '');
}

const TIMESPAN = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/;

function ttlOf(ctx: CmdletContext): number | undefined {
  const raw = ctx.named['timetolive'];
  if (raw === undefined) return undefined;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const span = raw as Record<string, PSValue>;
    if (typeof span.TotalSeconds === 'number') return Math.round(span.TotalSeconds);
    if (typeof span.TotalMilliseconds === 'number') return Math.round(span.TotalMilliseconds / 1000);
  }
  const text = psValueToString(raw);
  const span = TIMESPAN.exec(text);
  const seconds = span
    ? Number(span[1] ?? 0) * 86400 + Number(span[2]) * 3600 + Number(span[3]) * 60 + Number(span[4])
    : Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new PSRuntimeError(`Cannot bind parameter 'TimeToLive'. Cannot convert value "${text}" to type "System.TimeSpan".`);
  }
  return seconds;
}

// ── Zones ────────────────────────────────────────────────────────────────

export class AddDnsServerPrimaryZoneCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverprimaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'NetworkId', 'ZoneFile', 'ResponsiblePerson', 'DynamicUpdate', 'ReplicationScope', 'ComputerName', 'PassThru', 'LoadExisting'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerPrimaryZone');
    if (!guard(ctx, 'Add-DnsServerPrimaryZone', dns)) return null;
    const name = nameOf(ctx);
    const networkId = ctx.named['networkid'] !== undefined ? psValueToString(ctx.named['networkid']) : undefined;
    if (!name && !networkId) return missing(ctx, 'Add-DnsServerPrimaryZone', 'Name');
    const dynamicUpdate = choice(ctx, 'Add-DnsServerPrimaryZone', 'DynamicUpdate', 'dynamicupdate', DYNAMIC_UPDATE_MODES);
    const scope = choice(ctx, 'Add-DnsServerPrimaryZone', 'ReplicationScope', 'replicationscope', REPLICATION_SCOPES);
    if (dynamicUpdate === null || scope === null) return null;
    if (scope !== undefined && ctx.named['zonefile'] !== undefined) {
      ctx.emitError('Add-DnsServerPrimaryZone : -ZoneFile and -ReplicationScope cannot be combined: a zone is either file-backed or directory-integrated.');
      return null;
    }
    const before = new Set(dns.listZones().map(z => z.name));
    const res = dns.addPrimaryZone(name, {
      adminEmail: ctx.named['responsibleperson'] !== undefined ? psValueToString(ctx.named['responsibleperson']) : undefined,
      networkId,
      zoneFile: ctx.named['zonefile'] !== undefined ? psValueToString(ctx.named['zonefile']) : undefined,
      dynamicUpdate,
      dsIntegrated: scope !== undefined,
      loadExisting: isSwitchOn(ctx.named['loadexisting']),
    });
    return res.ok ? withPassThru(ctx, dns, before, name) : failed(ctx, 'Add-DnsServerPrimaryZone', res);
  }
}

export class AddDnsServerSecondaryZoneCmdlet implements ICmdlet {
  readonly name = 'add-dnsserversecondaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneFile', 'MasterServers', 'ComputerName', 'PassThru', 'LoadExisting'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerSecondaryZone');
    if (!guard(ctx, 'Add-DnsServerSecondaryZone', dns)) return null;
    const name = nameOf(ctx);
    const masters = stringList(ctx.named['masterservers']);
    if (!name || masters.length === 0) return missing(ctx, 'Add-DnsServerSecondaryZone', 'Name MasterServers');
    const zoneFile = ctx.named['zonefile'] !== undefined ? psValueToString(ctx.named['zonefile']) : undefined;
    const before = new Set(dns.listZones().map(z => z.name));
    const res = dns.addSecondaryZone(name, masters, zoneFile, isSwitchOn(ctx.named['loadexisting']));
    return res.ok ? withPassThru(ctx, dns, before, name) : failed(ctx, 'Add-DnsServerSecondaryZone', res);
  }
}

const CONDITIONAL_FORWARDER_UNBUILT = [
  ['zonefile', 'ZoneFile', 'a forwarder zone is not written to a zone file here'],
] as const;

export class AddDnsServerConditionalForwarderZoneCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverconditionalforwarderzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'MasterServers', 'ComputerName', 'PassThru', 'ForwarderTimeout', 'UseRecursion', 'ZoneFile'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerConditionalForwarderZone');
    if (!guard(ctx, 'Add-DnsServerConditionalForwarderZone', dns)) return null;
    const name = nameOf(ctx);
    const masters = stringList(ctx.named['masterservers']);
    if (!name || masters.length === 0) return missing(ctx, 'Add-DnsServerConditionalForwarderZone', 'Name MasterServers');
    if (refuseUnbuilt(ctx, 'Add-DnsServerConditionalForwarderZone', CONDITIONAL_FORWARDER_UNBUILT)) return null;
    if (!recursionKept(ctx, 'Add-DnsServerConditionalForwarderZone')) return null;
    const timeout = ctx.named['forwardertimeout'] !== undefined ? Number(psValueToString(ctx.named['forwardertimeout'])) : undefined;
    const before = new Set(dns.listZones().map(z => z.name));
    const res = dns.addConditionalForwarderZone(name, masters, timeout);
    return res.ok ? withPassThru(ctx, dns, before, name) : failed(ctx, 'Add-DnsServerConditionalForwarderZone', res);
  }
}

export class SetDnsServerConditionalForwarderZoneCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverconditionalforwarderzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'MasterServers', 'ComputerName', 'PassThru', 'ForwarderTimeout', 'UseRecursion'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerConditionalForwarderZone');
    if (!guard(ctx, 'Set-DnsServerConditionalForwarderZone', dns)) return null;
    const name = nameOf(ctx);
    const masters = ctx.named['masterservers'] !== undefined ? stringList(ctx.named['masterservers']) : undefined;
    if (!name || (masters !== undefined && masters.length === 0)) return missing(ctx, 'Set-DnsServerConditionalForwarderZone', 'Name MasterServers');
    if (!recursionKept(ctx, 'Set-DnsServerConditionalForwarderZone')) return null;
    if (masters === undefined && ctx.named['forwardertimeout'] === undefined) return missing(ctx, 'Set-DnsServerConditionalForwarderZone', 'MasterServers');
    const timeout = ctx.named['forwardertimeout'] !== undefined ? Number(psValueToString(ctx.named['forwardertimeout'])) : undefined;
    const res = dns.setConditionalForwarderMasters(name, masters, timeout);
    return res.ok ? withPassThru(ctx, dns, new Set(), name) : failed(ctx, 'Set-DnsServerConditionalForwarderZone', res);
  }
}

export class GetDnsServerZoneCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerZone');
    if (!guard(ctx, 'Get-DnsServerZone', dns)) return null;
    const name = nameOf(ctx);
    if (name) {
      const z = dns.getZone(name);
      if (!z) { ctx.emitError(`Get-DnsServerZone : Cannot find zone "${name}" on this server.`); return null; }
      return zoneToPSObject(z);
    }
    return dns.listZones().map(zoneToPSObject);
  }
}

export class SetDnsServerPrimaryZoneCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverprimaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'DynamicUpdate', 'SecureSecondaries', 'SecondaryServers', 'Notify', 'NotifyServers', 'ComputerName', 'PassThru', 'ZoneFile'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerPrimaryZone');
    if (!guard(ctx, 'Set-DnsServerPrimaryZone', dns)) return null;
    const name = nameOf(ctx);
    if (!name) return missing(ctx, 'Set-DnsServerPrimaryZone', 'Name');
    const dynamicUpdate = choice(ctx, 'Set-DnsServerPrimaryZone', 'DynamicUpdate', 'dynamicupdate', DYNAMIC_UPDATE_MODES);
    const secureSecondaries = choice<DnsTransferPolicy>(ctx, 'Set-DnsServerPrimaryZone', 'SecureSecondaries', 'securesecondaries', DNS_TRANSFER_POLICIES);
    const notify = choice<DnsNotifyPolicy>(ctx, 'Set-DnsServerPrimaryZone', 'Notify', 'notify', DNS_NOTIFY_POLICIES);
    if (dynamicUpdate === null || secureSecondaries === null || notify === null) return null;
    if (dynamicUpdate === undefined && secureSecondaries === undefined && notify === undefined
      && ctx.named['secondaryservers'] === undefined && ctx.named['notifyservers'] === undefined
      && ctx.named['zonefile'] === undefined) {
      return missing(ctx, 'Set-DnsServerPrimaryZone', 'DynamicUpdate');
    }
    const res = dns.setPrimaryZone(name, {
      dynamicUpdate, secureSecondaries, notify,
      secondaryServers: ctx.named['secondaryservers'] !== undefined ? stringList(ctx.named['secondaryservers']) : undefined,
      notifyServers: ctx.named['notifyservers'] !== undefined ? stringList(ctx.named['notifyservers']) : undefined,
    });
    if (!res.ok) return failed(ctx, 'Set-DnsServerPrimaryZone', res);
    if (ctx.named['zonefile'] !== undefined) {
      const renamed = dns.renameZoneFile(name, psValueToString(ctx.named['zonefile']));
      if (!renamed.ok) return failed(ctx, 'Set-DnsServerPrimaryZone', renamed);
    }
    return withPassThru(ctx, dns, new Set(), name);
  }
}

export class SetDnsServerSecondaryZoneCmdlet implements ICmdlet {
  readonly name = 'set-dnsserversecondaryzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'MasterServers', 'ComputerName', 'PassThru', 'ZoneFile', 'SecureSecondaries', 'SecondaryServers', 'Notify', 'NotifyServers'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerSecondaryZone');
    if (!guard(ctx, 'Set-DnsServerSecondaryZone', dns)) return null;
    const name = nameOf(ctx);
    if (!name) return missing(ctx, 'Set-DnsServerSecondaryZone', 'Name');
    if (refuseUnbuilt(ctx, 'Set-DnsServerSecondaryZone', [
      ['notify', 'Notify', 'a secondary zone does not send NOTIFY onward (cascaded secondaries are not built)'],
      ['notifyservers', 'NotifyServers', 'a secondary zone does not send NOTIFY onward (cascaded secondaries are not built)'],
    ])) return null;
    const secureSecondaries = choice<DnsTransferPolicy>(ctx, 'Set-DnsServerSecondaryZone', 'SecureSecondaries', 'securesecondaries', DNS_TRANSFER_POLICIES);
    if (secureSecondaries === null) return null;
    const masters = ctx.named['masterservers'] !== undefined ? stringList(ctx.named['masterservers']) : undefined;
    if (masters === undefined && secureSecondaries === undefined && ctx.named['secondaryservers'] === undefined
      && ctx.named['zonefile'] === undefined) {
      return missing(ctx, 'Set-DnsServerSecondaryZone', 'MasterServers');
    }
    const res = dns.setSecondaryZone(name, {
      masters, secureSecondaries,
      secondaryServers: ctx.named['secondaryservers'] !== undefined ? stringList(ctx.named['secondaryservers']) : undefined,
    });
    if (!res.ok) return failed(ctx, 'Set-DnsServerSecondaryZone', res);
    if (ctx.named['zonefile'] !== undefined) {
      const renamed = dns.renameZoneFile(name, psValueToString(ctx.named['zonefile']));
      if (!renamed.ok) return failed(ctx, 'Set-DnsServerSecondaryZone', renamed);
    }
    return withPassThru(ctx, dns, new Set(), name);
  }
}

export class RemoveDnsServerZoneCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverzone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Force', 'Confirm', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerZone');
    if (!guard(ctx, 'Remove-DnsServerZone', dns)) return null;
    const name = nameOf(ctx);
    if (!name) return missing(ctx, 'Remove-DnsServerZone', 'Name');
    const res = dns.removeZone(name);
    return res.ok ? null : failed(ctx, 'Remove-DnsServerZone', res);
  }
}

export class StartDnsServerZoneTransferCmdlet implements ICmdlet {
  readonly name = 'start-dnsserverzonetransfer';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'FullTransfer', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Start-DnsServerZoneTransfer');
    if (!guard(ctx, 'Start-DnsServerZoneTransfer', dns)) return null;
    const name = nameOf(ctx);
    if (!name) return missing(ctx, 'Start-DnsServerZoneTransfer', 'Name');
    const res = dns.startZoneTransfer(name);
    return res.ok ? null : failed(ctx, 'Start-DnsServerZoneTransfer', res);
  }
}

export class AddDnsServerTsigKeyCmdlet implements ICmdlet {
  readonly name = 'add-dnsservertsigkey';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Algorithm', 'Secret', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerTsigKey');
    if (!guard(ctx, 'Add-DnsServerTsigKey', dns)) return null;
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
  readonly parameters = ['ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerTsigKey');
    if (!guard(ctx, 'Get-DnsServerTsigKey', dns)) return null;
    return dns.listTsigKeys().map(k => ({ Name: k.name, Algorithm: k.algorithm }));
  }
}

export class RemoveDnsServerTsigKeyCmdlet implements ICmdlet {
  readonly name = 'remove-dnsservertsigkey';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerTsigKey');
    if (!guard(ctx, 'Remove-DnsServerTsigKey', dns)) return null;
    const res = dns.removeTsigKey(nameOf(ctx));
    if (!res.ok) { ctx.emitError(`Remove-DnsServerTsigKey : ${res.message}`); return null; }
    return null;
  }
}

// ── Resource records ─────────────────────────────────────────────────────

export class AddDnsServerResourceRecordACmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecorda';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'IPv4Address', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny', 'CreatePtr'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordA');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecordA', dns)) return null;
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ip = psValueToString(ctx.named['ipv4address'] ?? '');
    if (!zone || !name || !ip) return missing(ctx, 'Add-DnsServerResourceRecordA', 'ZoneName Name IPv4Address');
    const res = isSwitchOn(ctx.named['createptr'])
      ? dns.addRecord(zone, name, { type: 'A', data: { IPv4Address: ip } }, ttlOf(ctx), true)
      : dns.addARecord(zone, name, ip, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecordA', res);
  }
}

export class AddDnsServerResourceRecordAAAACmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordaaaa';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'IPv6Address', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny', 'CreatePtr'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordAAAA');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecordAAAA', dns)) return null;
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ip = psValueToString(ctx.named['ipv6address'] ?? '');
    if (!zone || !name || !ip) return missing(ctx, 'Add-DnsServerResourceRecordAAAA', 'ZoneName Name IPv6Address');
    if (isSwitchOn(ctx.named['createptr'])) {
      ctx.emitError('Add-DnsServerResourceRecordAAAA : -CreatePtr is refused: IPv6 reverse zones (ip6.arpa) are not built.');
      return null;
    }
    const res = dns.addAaaaRecord(zone, name, ip, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecordAAAA', res);
  }
}

export class AddDnsServerResourceRecordCNameCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordcname';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'HostNameAlias', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordCName');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecordCName', dns)) return null;
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const alias = psValueToString(ctx.named['hostnamealias'] ?? '');
    if (!zone || !name || !alias) return missing(ctx, 'Add-DnsServerResourceRecordCName', 'ZoneName Name HostNameAlias');
    const res = dns.addCnameRecord(zone, name, alias, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecordCName', res);
  }
}

export class AddDnsServerResourceRecordMXCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordmx';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'MailExchange', 'Preference', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordMX');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecordMX', dns)) return null;
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const exchange = psValueToString(ctx.named['mailexchange'] ?? '');
    const preference = ctx.named['preference'] !== undefined ? Number(psValueToString(ctx.named['preference'])) : 10;
    if (!zone || !name || !exchange) return missing(ctx, 'Add-DnsServerResourceRecordMX', 'ZoneName Name MailExchange');
    const res = dns.addMxRecord(zone, name, preference, exchange, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecordMX', res);
  }
}

export class AddDnsServerResourceRecordPtrCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecordptr';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'PtrDomainName', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecordPtr');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecordPtr', dns)) return null;
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    const ptr = psValueToString(ctx.named['ptrdomainname'] ?? '');
    if (!zone || !name || !ptr) return missing(ctx, 'Add-DnsServerResourceRecordPtr', 'ZoneName Name PtrDomainName');
    const res = dns.addPtrRecord(zone, name, ptr, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecordPtr', res);
  }
}

const RECORD_SWITCHES: readonly { switchName: string; type: string; fields: readonly [string, string][] }[] = [
  { switchName: 'a', type: 'A', fields: [['IPv4Address', 'ipv4address']] },
  { switchName: 'aaaa', type: 'AAAA', fields: [['IPv6Address', 'ipv6address']] },
  { switchName: 'cname', type: 'CNAME', fields: [['HostNameAlias', 'hostnamealias']] },
  { switchName: 'ptr', type: 'PTR', fields: [['PtrDomainName', 'ptrdomainname']] },
  { switchName: 'ns', type: 'NS', fields: [['NameServer', 'nameserver']] },
  { switchName: 'txt', type: 'TXT', fields: [['DescriptiveText', 'descriptivetext']] },
  { switchName: 'mx', type: 'MX', fields: [['Preference', 'preference'], ['MailExchange', 'mailexchange']] },
  {
    switchName: 'srv', type: 'SRV',
    fields: [['Priority', 'priority'], ['Weight', 'weight'], ['Port', 'port'], ['DomainName', 'domainname']],
  },
];

export class AddDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'A', 'AAAA', 'CName', 'Ptr', 'NS', 'Txt', 'Mx', 'Srv', 'IPv4Address', 'IPv6Address',
    'HostNameAlias', 'PtrDomainName', 'NameServer', 'DescriptiveText', 'MailExchange', 'Preference',
    'Priority', 'Weight', 'Port', 'DomainName', 'DomainNameTarget', 'TimeToLive',, 'ComputerName', 'AgeRecord', 'AllowUpdateAny', 'CreatePtr'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerResourceRecord');
    if (!recordGuard(ctx, 'Add-DnsServerResourceRecord', dns)) return null;
    const chosen = RECORD_SWITCHES.filter(entry => isSwitchOn(ctx.named[entry.switchName]));
    if (chosen.length !== 1) {
      ctx.emitError('Add-DnsServerResourceRecord : Parameter set cannot be resolved using the specified named parameters: exactly one of -A, -AAAA, -CName, -Ptr, -NS, -Txt, -Mx or -Srv is required.');
      return null;
    }
    const zone = zoneNameOf(ctx);
    const name = nameOf(ctx);
    if (!zone || !name) return missing(ctx, 'Add-DnsServerResourceRecord', 'ZoneName Name');
    const [entry] = chosen;
    const data: Record<string, string | number> = {};
    for (const [field, key] of entry.fields) {
      const raw = ctx.named[key] ?? (field === 'DomainName' ? ctx.named['domainnametarget'] : undefined);
      if (raw !== undefined) data[field] = psValueToString(raw);
    }
    const spec: DnsRecordSpec = { type: entry.type, data };
    const res = dns.addRecord(zone, name, spec, ttlOf(ctx), isSwitchOn(ctx.named['createptr']));
    return res.ok ? null : failed(ctx, 'Add-DnsServerResourceRecord', res);
  }
}

function single(item: PSValue | undefined): PSValue | undefined {
  return Array.isArray(item) && item.length === 1 ? item[0] : item;
}

function specOf(candidate: PSValue | undefined): DnsRecordSpec | null {
  const item = single(candidate);
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, PSValue>;
  const type = psValueToString(record.RecordType ?? '');
  const raw = record.RecordData;
  if (!type || raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data: Record<string, string | number> = {};
  for (const [field, value] of Object.entries(raw as Record<string, PSValue>)) {
    if (field.startsWith('__')) continue;
    if (typeof value === 'number' || typeof value === 'string') data[field] = value;
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const text = (value as Record<string, PSValue>).IPAddressToString;
      if (text !== undefined) data[field] = psValueToString(text);
    }
  }
  return { type, data };
}

function hostOf(candidate: PSValue | undefined): string {
  const item = single(candidate);
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    ? psValueToString((item as Record<string, PSValue>).HostName ?? '') : '';
}

const SINGLE_FIELD: Record<string, string> = {
  A: 'IPv4Address', AAAA: 'IPv6Address', CNAME: 'HostNameAlias', PTR: 'PtrDomainName', NS: 'NameServer', TXT: 'DescriptiveText',
};

export class RemoveDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'RRType', 'RecordData', 'InputObject', 'Force', 'Confirm', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;
  readonly pipelineByValue = 'InputObject';

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerResourceRecord');
    if (!recordGuard(ctx, 'Remove-DnsServerResourceRecord', dns)) return null;
    const zone = zoneNameOf(ctx);
    const input = ctx.named['inputobject'];
    if (input !== undefined) {
      const spec = specOf(input);
      const host = hostOf(input);
      if (!zone || !spec || !host) return missing(ctx, 'Remove-DnsServerResourceRecord', 'ZoneName InputObject');
      const res = dns.removeRecord(zone, host, spec.type, spec.data);
      return res.ok ? null : failed(ctx, 'Remove-DnsServerResourceRecord', res);
    }
    const name = nameOf(ctx);
    const type = psValueToString(ctx.named['rrtype'] ?? '');
    if (!zone || !name || !type) return missing(ctx, 'Remove-DnsServerResourceRecord', 'ZoneName Name RRType');
    let data: Record<string, string | number> | undefined;
    if (ctx.named['recorddata'] !== undefined) {
      const field = SINGLE_FIELD[type.toUpperCase()];
      if (!field) {
        ctx.emitError(`Remove-DnsServerResourceRecord : -RecordData cannot select a ${type} record; pipe the record from Get-DnsServerResourceRecord instead.`);
        return null;
      }
      data = { [field]: psValueToString(ctx.named['recorddata']) };
    }
    const res = dns.removeRecord(zone, name, type, data);
    return res.ok ? null : failed(ctx, 'Remove-DnsServerResourceRecord', res);
  }
}

export class SetDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'OldInputObject', 'NewInputObject', 'TimeToLive', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerResourceRecord');
    if (!recordGuard(ctx, 'Set-DnsServerResourceRecord', dns)) return null;
    const zone = zoneNameOf(ctx);
    const previous = specOf(ctx.named['oldinputobject']);
    const next = specOf(ctx.named['newinputobject']);
    const host = hostOf(ctx.named['oldinputobject']);
    if (!zone || !previous || !next || !host) return missing(ctx, 'Set-DnsServerResourceRecord', 'ZoneName OldInputObject NewInputObject');
    if (previous.type.toUpperCase() !== next.type.toUpperCase()) {
      ctx.emitError('Set-DnsServerResourceRecord : the new record must have the same type as the old one.');
      return null;
    }
    const res = dns.replaceRecord(zone, host, previous, next, ttlOf(ctx));
    return res.ok ? null : failed(ctx, 'Set-DnsServerResourceRecord', res);
  }
}

export class GetDnsServerResourceRecordCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverresourcerecord';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'RRType', 'ComputerName', 'AgeRecord', 'AllowUpdateAny'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Get-DnsServerResourceRecord');
    if (!recordGuard(ctx, 'Get-DnsServerResourceRecord', dns)) return null;
    const zone = zoneNameOf(ctx);
    if (!zone) return missing(ctx, 'Get-DnsServerResourceRecord', 'ZoneName');
    const name = ctx.named['name'] !== undefined ? psValueToString(ctx.named['name']) : undefined;
    const type = ctx.named['rrtype'] !== undefined ? psValueToString(ctx.named['rrtype']) : undefined;
    const records = dns.getRecords(zone, name, type);
    if (!records) { ctx.emitError(`Get-DnsServerResourceRecord : Cannot find zone "${zone}" on this server.`); return null; }
    return records.map(record => recordToPSObject(record, zone));
  }
}

// ── Forwarders, recursion, cache ─────────────────────────────────────────

const ROOT_HINTS_MISSING = 'root hints are not built: this server can only recurse through forwarders, so -UseRootHint $true is refused.';

export class SetDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = ['IPAddress', 'UseRootHint', 'Timeout', 'ComputerName', 'EnableReordering'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerForwarder');
    if (!guard(ctx, 'Set-DnsServerForwarder', dns)) return null;
    if (isSwitchOn(ctx.named['useroothint'])) {
      ctx.emitError(`Set-DnsServerForwarder : ${ROOT_HINTS_MISSING}`);
      return null;
    }
    if (ctx.named['enablereordering'] !== undefined && !isSwitchOn(ctx.named['enablereordering'])) {
      ctx.emitError('Set-DnsServerForwarder : -EnableReordering $false is refused: forwarders are always tried in the order listed; RTT-based reordering is not built.');
      return null;
    }
    if (ctx.named['timeout'] !== undefined) {
      const res = dns.setForwarderTimeout(Number(psValueToString(ctx.named['timeout'])));
      if (!res.ok) return failed(ctx, 'Set-DnsServerForwarder', res);
    }
    const raw = ctx.named['ipaddress'] ?? (ctx.positional.length > 0 ? ctx.positional : undefined);
    if (raw === undefined) return null;
    const res = dns.setForwarders(stringList(raw));
    return res.ok ? null : failed(ctx, 'Set-DnsServerForwarder', res);
  }
}

export class AddDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = ['IPAddress', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Add-DnsServerForwarder');
    if (!guard(ctx, 'Add-DnsServerForwarder', dns)) return null;
    const addresses = stringList(ctx.named['ipaddress'] ?? (ctx.positional.length > 0 ? ctx.positional : undefined));
    if (addresses.length === 0) return missing(ctx, 'Add-DnsServerForwarder', 'IPAddress');
    const res = dns.addForwarders(addresses);
    return res.ok ? null : failed(ctx, 'Add-DnsServerForwarder', res);
  }
}

export class RemoveDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = ['IPAddress', 'Force', 'Confirm', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Remove-DnsServerForwarder');
    if (!guard(ctx, 'Remove-DnsServerForwarder', dns)) return null;
    const addresses = stringList(ctx.named['ipaddress'] ?? (ctx.positional.length > 0 ? ctx.positional : undefined));
    if (addresses.length === 0) return missing(ctx, 'Remove-DnsServerForwarder', 'IPAddress');
    const res = dns.removeForwarders(addresses);
    return res.ok ? null : failed(ctx, 'Remove-DnsServerForwarder', res);
  }
}

export class GetDnsServerForwarderCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverforwarder';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const info = requireDns(ctx, 'Get-DnsServerForwarder').getForwarderInfo();
    return { IPAddress: info.addresses, UseRootHint: info.useRootHint, Timeout: info.timeoutSeconds };
  }
}

export class SetDnsServerRecursionCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverrecursion';
  readonly aliases = [] as const;
  readonly parameters = ['Enable', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerRecursion');
    if (!guard(ctx, 'Set-DnsServerRecursion', dns)) return null;
    if (ctx.named['enable'] === undefined) return missing(ctx, 'Set-DnsServerRecursion', 'Enable');
    dns.setRecursion(isSwitchOn(ctx.named['enable']));
    return null;
  }
}

export class GetDnsServerRecursionCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverrecursion';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    return { Enable: requireDns(ctx, 'Get-DnsServerRecursion').isRecursionEnabled() };
  }
}

export class ClearDnsServerCacheCmdlet implements ICmdlet {
  readonly name = 'clear-dnsservercache';
  readonly aliases = [] as const;
  readonly parameters = ['Force', 'Confirm', 'ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    requireDns(ctx, 'Clear-DnsServerCache').clearCache();
    return null;
  }
}

export class ShowDnsServerCacheCmdlet implements ICmdlet {
  readonly name = 'show-dnsservercache';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName'] as const;

  execute(ctx: CmdletContext): PSValue {
    return requireDns(ctx, 'Show-DnsServerCache').cacheEntries().map(entry => ({
      HostName: entry.name, RecordType: entry.type, TimeToLive: entry.ttl, RecordData: entry.data,
    }));
  }
}
