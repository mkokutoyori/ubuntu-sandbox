import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { PolicyCriteriaText, PolicyView } from '@/powershell/providers/PSProviders';
import { POLICY_REFUSALS } from '@/network/devices/windows/server/dns/DnsPolicies';
import { POLICY_CONDITIONS } from '@/network/devices/windows/server/dns/DnsPolicyCriteria';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, missing, requireDns } from './DnsServerCmdlets';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

const SETTING_PARAMETERS = ['ClientSubnet', 'Fqdn', 'ServerInterfaceIP', 'Name', 'Condition'] as const;

function exceptionListObject(view: PolicyView): Record<string, PSValue> {
  return {
    Name: view.name,
    Condition: view.condition === 'AND' ? 'And' : 'Or',
    ClientSubnet: view.clientSubnet,
    Fqdn: view.fqdn,
    ServerInterfaceIP: view.serverInterface,
  };
}

function nameArgument(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

function criterionArgument(ctx: CmdletContext, key: string, position: number): string | undefined {
  const given = ctx.named[key] ?? ctx.positional[position];
  return given === undefined ? undefined : psValueToString(given);
}

function criteriaArguments(ctx: CmdletContext): PolicyCriteriaText {
  const clientSubnet = criterionArgument(ctx, 'clientsubnet', 1);
  const fqdn = criterionArgument(ctx, 'fqdn', 2);
  const serverInterface = criterionArgument(ctx, 'serverinterfaceip', 3);
  return {
    ...(clientSubnet === undefined ? {} : { clientSubnet }),
    ...(fqdn === undefined ? {} : { fqdn }),
    ...(serverInterface === undefined ? {} : { serverInterface }),
  };
}

function byName(dns: { getRateLimitingExceptionLists(): PolicyView[] }, name: string): PolicyView | undefined {
  return dns.getRateLimitingExceptionLists().find(view => view.name.toLowerCase() === name.toLowerCase());
}

export class AddDnsServerResponseRateLimitingExceptionlistCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverresponseratelimitingexceptionlist';
  readonly displayName = 'Add-DnsServerResponseRateLimitingExceptionlist';
  readonly aliases = [] as const;
  readonly parameters = [...SETTING_PARAMETERS, 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
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
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS, 4);
    if (condition === null) return null;
    const result = dns.addRateLimitingExceptionList(name, condition ?? 'AND', criteriaArguments(ctx));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = byName(dns, name);
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? exceptionListObject(created) : null;
  }
}

export class GetDnsServerResponseRateLimitingExceptionlistCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverresponseratelimitingexceptionlist';
  readonly displayName = 'Get-DnsServerResponseRateLimitingExceptionlist';
  readonly aliases = [] as const;
  readonly parameters = ['Name', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return dns.getRateLimitingExceptionLists().map(exceptionListObject);
    const found = byName(dns, name);
    return found === undefined ? failed(ctx, this.displayName, { ok: false, message: POLICY_REFUSALS.missing }) : exceptionListObject(found);
  }
}

export class SetDnsServerResponseRateLimitingExceptionlistCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverresponseratelimitingexceptionlist';
  readonly displayName = 'Set-DnsServerResponseRateLimitingExceptionlist';
  readonly aliases = [] as const;
  readonly parameters = [...SETTING_PARAMETERS, 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
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
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS, 4);
    if (condition === null) return null;
    const result = dns.changeRateLimitingExceptionList(name, condition, criteriaArguments(ctx));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const changed = byName(dns, name);
    return isSwitchOn(ctx.named['passthru']) && changed !== undefined ? exceptionListObject(changed) : null;
  }
}

export class RemoveDnsServerResponseRateLimitingExceptionlistCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverresponseratelimitingexceptionlist';
  readonly displayName = 'Remove-DnsServerResponseRateLimitingExceptionlist';
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
    const held = byName(dns, name);
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.removeRateLimitingExceptionList(name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? exceptionListObject(held) : null;
  }
}
