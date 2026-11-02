import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDnsServerProvider, RecursionScopeChanges, RecursionScopeView } from '@/powershell/providers/PSProviders';
import { RECURSION_SCOPE_REFUSALS } from '@/network/devices/windows/server/dns/DnsRecursionScopes';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { failed, isSwitchOn, missing, requireDns, stringList } from './DnsServerCmdlets';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

function scopeObject(view: RecursionScopeView): Record<string, PSValue> {
  return { Name: view.name, Forwarder: view.forwarders.length === 0 ? null : [...view.forwarders], EnableRecursion: view.enableRecursion };
}

function nameArgument(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

function forwarderArgument(ctx: CmdletContext): string[] | undefined {
  const given = ctx.named['forwarder'] ?? ctx.positional[1];
  return given === undefined ? undefined : stringList(given);
}

function enableArgument(ctx: CmdletContext): boolean | undefined {
  const given = ctx.named['enablerecursion'] ?? ctx.positional[2];
  return given === undefined ? undefined : isSwitchOn(given);
}

function viewOf(dns: IDnsServerProvider, name: string): RecursionScopeView | undefined {
  return dns.getRecursionScopes().find(view => view.name.toLowerCase() === name.trim().toLowerCase());
}

function changesFrom(ctx: CmdletContext): RecursionScopeChanges {
  return { forwarders: forwarderArgument(ctx), enableRecursion: enableArgument(ctx) };
}

export class AddDnsServerRecursionScopeCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverrecursionscope';
  readonly displayName = 'Add-DnsServerRecursionScope';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Forwarder', 'EnableRecursion', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const result = dns.addRecursionScope(name, forwarderArgument(ctx) ?? [], enableArgument(ctx) ?? true);
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = viewOf(dns, name);
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? scopeObject(created) : null;
  }
}

export class GetDnsServerRecursionScopeCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverrecursionscope';
  readonly displayName = 'Get-DnsServerRecursionScope';
  readonly aliases = [] as const;
  readonly parameters = ['Name', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return dns.getRecursionScopes().map(scopeObject);
    const found = viewOf(dns, name);
    return found === undefined ? failed(ctx, this.displayName, { ok: false, message: RECURSION_SCOPE_REFUSALS.missing }) : scopeObject(found);
  }
}

export class SetDnsServerRecursionScopeCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverrecursionscope';
  readonly displayName = 'Set-DnsServerRecursionScope';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'Forwarder', 'EnableRecursion', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const result = dns.changeRecursionScope(name, changesFrom(ctx));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const changed = viewOf(dns, name);
    return isSwitchOn(ctx.named['passthru']) && changed !== undefined ? scopeObject(changed) : null;
  }
}

export class RemoveDnsServerRecursionScopeCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverrecursionscope';
  readonly displayName = 'Remove-DnsServerRecursionScope';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'PassThru', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const held = viewOf(dns, name);
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.removeRecursionScope(name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? scopeObject(held) : null;
  }
}
