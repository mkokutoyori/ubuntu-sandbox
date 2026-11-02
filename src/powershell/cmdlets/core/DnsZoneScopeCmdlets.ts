import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ZoneScopeView } from '@/powershell/providers/PSProviders';
import { ZONE_SCOPE_REFUSALS } from '@/network/devices/windows/server/dns/DnsZoneScopes';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { failed, isSwitchOn, missing, requireDns } from './DnsServerCmdlets';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

function scopeObject(zone: string, view: ZoneScopeView): Record<string, PSValue> {
  return { ZoneName: zone, ZoneScope: view.name, FileName: view.fileName };
}

function zoneArgument(ctx: CmdletContext): string {
  return psValueToString(ctx.named['zonename'] ?? ctx.positional[0] ?? '');
}

function nameArgument(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.named['zonescope'] ?? ctx.positional[1] ?? '');
}

function requiredArguments(ctx: CmdletContext, cmdletName: string): { zone: string; name: string } | null {
  const zone = zoneArgument(ctx);
  const name = nameArgument(ctx);
  if (zone === '' || name === '') {
    missing(ctx, cmdletName, [zone === '' ? 'ZoneName' : '', name === '' ? 'Name' : ''].filter(Boolean).join(' '));
    return null;
  }
  return { zone, name };
}

export class AddDnsServerZoneScopeCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverzonescope';
  readonly displayName = 'Add-DnsServerZoneScope';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'ZoneScope', 'LoadExisting', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['LoadExisting', 'PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const given = requiredArguments(ctx, this.displayName);
    if (given === null) return null;
    const result = dns.addZoneScope(given.zone, given.name, isSwitchOn(ctx.named['loadexisting']));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = dns.getZoneScopes(given.zone).scopes.find(view => view.name.toLowerCase() === given.name.trim().toLowerCase());
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? scopeObject(given.zone, created) : null;
  }
}

export class GetDnsServerZoneScopeCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverzonescope';
  readonly displayName = 'Get-DnsServerZoneScope';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'ZoneScope', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zone = zoneArgument(ctx);
    if (zone === '') return missing(ctx, this.displayName, 'ZoneName');
    const listing = dns.getZoneScopes(zone);
    if (!listing.ok) return failed(ctx, this.displayName, listing);
    const name = nameArgument(ctx);
    if (name === '') return listing.scopes.map(view => scopeObject(zone, view));
    const found = listing.scopes.find(view => view.name.toLowerCase() === name.trim().toLowerCase());
    return found === undefined ? failed(ctx, this.displayName, { ok: false, message: ZONE_SCOPE_REFUSALS.absent }) : scopeObject(zone, found);
  }
}

export class RemoveDnsServerZoneScopeCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverzonescope';
  readonly displayName = 'Remove-DnsServerZoneScope';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Name', 'ZoneScope', 'PassThru', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const given = requiredArguments(ctx, this.displayName);
    if (given === null) return null;
    const held = dns.getZoneScopes(given.zone).scopes.find(view => view.name.toLowerCase() === given.name.trim().toLowerCase());
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.removeZoneScope(given.zone, given.name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? scopeObject(given.zone, held) : null;
  }
}
