import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { DnsOpResult, IDnsServerProvider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { failed, isSwitchOn, missing, requireDns, zoneToPSObject } from './DnsServerCmdlets';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

function zoneArgument(ctx: CmdletContext, position: number): string {
  return psValueToString(ctx.named['name'] ?? ctx.named['zonename'] ?? ctx.positional[position] ?? '');
}

function zoneOutput(ctx: CmdletContext, dns: IDnsServerProvider, zone: string): PSValue {
  if (!isSwitchOn(ctx.named['passthru'])) return null;
  const info = dns.getZone(zone);
  return info === null ? null : zoneToPSObject(info);
}

abstract class ConfirmedZoneOperation implements ICmdlet {
  abstract readonly name: string;
  abstract readonly displayName: string;
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', 'PassThru', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  protected abstract apply(dns: IDnsServerProvider, zone: string): DnsOpResult;

  whatIfTarget(ctx: CmdletContext): string {
    return zoneArgument(ctx, 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zone = zoneArgument(ctx, 0);
    if (zone === '') return missing(ctx, this.displayName, 'Name');
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = this.apply(dns, zone);
    return result.ok ? zoneOutput(ctx, dns, zone) : failed(ctx, this.displayName, result);
  }
}

export class SuspendDnsServerZoneCmdlet extends ConfirmedZoneOperation {
  readonly name = 'suspend-dnsserverzone';
  readonly displayName = 'Suspend-DnsServerZone';

  protected apply(dns: IDnsServerProvider, zone: string): DnsOpResult {
    return dns.setZonePaused(zone, true);
  }
}

export class ResumeDnsServerZoneCmdlet extends ConfirmedZoneOperation {
  readonly name = 'resume-dnsserverzone';
  readonly displayName = 'Resume-DnsServerZone';

  protected apply(dns: IDnsServerProvider, zone: string): DnsOpResult {
    return dns.setZonePaused(zone, false);
  }
}

export class RestoreDnsServerPrimaryZoneCmdlet extends ConfirmedZoneOperation {
  readonly name = 'restore-dnsserverprimaryzone';
  readonly displayName = 'Restore-DnsServerPrimaryZone';

  protected apply(dns: IDnsServerProvider, zone: string): DnsOpResult {
    return dns.restorePrimaryZone(zone);
  }
}

export class RestoreDnsServerSecondaryZoneCmdlet extends ConfirmedZoneOperation {
  readonly name = 'restore-dnsserversecondaryzone';
  readonly displayName = 'Restore-DnsServerSecondaryZone';

  protected apply(dns: IDnsServerProvider, zone: string): DnsOpResult {
    return dns.restoreSecondaryZone(zone);
  }
}

export class SyncDnsServerZoneCmdlet implements ICmdlet {
  readonly name = 'sync-dnsserverzone';
  readonly displayName = 'Sync-DnsServerZone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return zoneArgument(ctx, 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zone = zoneArgument(ctx, 0);
    const result = dns.syncZones(zone === '' ? null : zone);
    if (!result.ok) return failed(ctx, this.displayName, result);
    if (!isSwitchOn(ctx.named['passthru'])) return null;
    return zone === '' ? dns.listZones().map(zoneToPSObject) : zoneOutput(ctx, dns, zone);
  }
}

export class SetDnsServerResourceRecordAgingCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverresourcerecordaging';
  readonly displayName = 'Set-DnsServerResourceRecordAging';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'NodeName', 'Recurse', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['Recurse', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return psValueToString(ctx.named['zonename'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zone = psValueToString(ctx.named['zonename'] ?? ctx.positional[0] ?? '');
    if (zone === '') return missing(ctx, this.displayName, 'ZoneName');
    const node = ctx.named['nodename'] ?? ctx.positional[1];
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.ageRecords(zone, node === undefined ? null : psValueToString(node), isSwitchOn(ctx.named['recurse']));
    return result.ok ? null : failed(ctx, this.displayName, result);
  }
}

export class ExportDnsServerZoneCmdlet implements ICmdlet {
  readonly name = 'export-dnsserverzone';
  readonly displayName = 'Export-DnsServerZone';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', 'FileName', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return zoneArgument(ctx, 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zone = zoneArgument(ctx, 0);
    const fileName = psValueToString(ctx.named['filename'] ?? ctx.positional[1] ?? '');
    if (zone === '' || fileName === '') return missing(ctx, this.displayName, [zone === '' ? 'Name' : '', fileName === '' ? 'FileName' : ''].filter(Boolean).join(' '));
    const result = dns.exportZone(zone, fileName);
    return result.ok ? zoneOutput(ctx, dns, zone) : failed(ctx, this.displayName, result);
  }
}
