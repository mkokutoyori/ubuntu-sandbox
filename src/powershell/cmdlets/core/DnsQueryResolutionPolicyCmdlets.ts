import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDnsServerProvider, NewPolicy, PolicyContentEntry, PolicyView } from '@/powershell/providers/PSProviders';
import { POLICY_ACTIONS, POLICY_REFUSALS } from '@/network/devices/windows/server/dns/DnsPolicies';
import { POLICY_CONDITIONS } from '@/network/devices/windows/server/dns/DnsPolicyCriteria';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, missing, requireDns } from './DnsServerCmdlets';
import { UINT32_MAXIMUM, countSetting } from './DnsServerSettingsCmdlets';
import {
  POLICY_CRITERIA_PARAMETERS, contentFromText, criteriaFromNamed, inputObject, mergedCriteria, nameArgument, policyName, policyObject, positional,
  zoneArgument,
} from './DnsPolicyObjects';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

const CRITERIA_PARAMETERS = POLICY_CRITERIA_PARAMETERS.map(entry => entry.parameter);

function contentArgument(ctx: CmdletContext, key: string): PolicyContentEntry[] | undefined {
  const given = ctx.named[key];
  return given === undefined ? undefined : contentFromText(psValueToString(given));
}

function viewOf(dns: IDnsServerProvider, zone: string | null, name: string): PolicyView | undefined {
  return dns.getQueryResolutionPolicies(zone).policies.find(view => view.name.toLowerCase() === name.toLowerCase());
}

function refuseEcs(ctx: CmdletContext, cmdletName: string): boolean {
  if (ctx.named['ecs'] === undefined) return false;
  failed(ctx, cmdletName, { ok: false, message: POLICY_REFUSALS.invalidSettings });
  return true;
}

export class AddDnsServerQueryResolutionPolicyCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverqueryresolutionpolicy';
  readonly displayName = 'Add-DnsServerQueryResolutionPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'Action', 'Condition', 'PassThru', 'ECS', ...CRITERIA_PARAMETERS, 'ApplyOnRecursion', 'ProcessingOrder', 'RecursionScope',
    'Disable', 'ZoneName', 'ZoneScope', 'InputObject', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm',
  ] as const;
  readonly switchParameters = ['PassThru', 'ApplyOnRecursion', 'Disable', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByValue = 'InputObject';

  whatIfTarget(ctx: CmdletContext): string {
    return policyName(ctx, inputObject(ctx), 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const record = inputObject(ctx);
    const name = policyName(ctx, record, 0);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    if (refuseEcs(ctx, this.displayName)) return null;
    const action = choice(ctx, this.displayName, 'Action', 'action', POLICY_ACTIONS, 1);
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS, 2);
    const order = countSetting(ctx, this.displayName, 'processingorder', 'ProcessingOrder', UINT32_MAXIMUM);
    if (action === null || condition === null || order === null) return null;
    const chosen = action ?? record?.action ?? null;
    if (chosen === null) return failed(ctx, this.displayName, { ok: false, message: POLICY_REFUSALS.invalidSettings });
    const zone = zoneArgument(ctx) ?? record?.zone ?? null;
    const recursive = isSwitchOn(ctx.named['applyonrecursion']) || record?.kind === 'Recursion';
    const spec: NewPolicy = {
      name,
      kind: recursive ? 'Recursion' : 'QueryProcessing',
      action: chosen,
      condition: condition ?? record?.condition ?? 'AND',
      enabled: !isSwitchOn(ctx.named['disable']) && (record?.enabled ?? true),
      processingOrder: order,
      criteria: mergedCriteria(criteriaFromNamed(ctx), record),
      content: contentArgument(ctx, zone === null ? 'recursionscope' : 'zonescope') ?? record?.content ?? [],
    };
    const result = dns.addQueryResolutionPolicy(zone, spec);
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = viewOf(dns, zone, name);
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? policyObject(created) : null;
  }
}

export class GetDnsServerQueryResolutionPolicyCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverqueryresolutionpolicy';
  readonly displayName = 'Get-DnsServerQueryResolutionPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zoneText = positional(ctx, 'zonename', 1);
    const listed = dns.getQueryResolutionPolicies(zoneText === undefined || zoneText === '' ? null : zoneText);
    if (!listed.ok) return failed(ctx, this.displayName, listed);
    const name = positional(ctx, 'name', 0);
    if (name === undefined || name === '') return listed.policies.map(policyObject);
    const found = listed.policies.find(view => view.name.toLowerCase() === name.toLowerCase());
    return found === undefined ? failed(ctx, this.displayName, { ok: false, message: POLICY_REFUSALS.missing }) : policyObject(found);
  }
}

export class SetDnsServerQueryResolutionPolicyCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverqueryresolutionpolicy';
  readonly displayName = 'Set-DnsServerQueryResolutionPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'PassThru', 'ECS', ...CRITERIA_PARAMETERS, 'Condition', 'ProcessingOrder', 'RecursionScope', 'ZoneName', 'ZoneScope',
    'InputObject', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm',
  ] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByValue = 'InputObject';

  whatIfTarget(ctx: CmdletContext): string {
    return policyName(ctx, inputObject(ctx));
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const record = inputObject(ctx);
    const name = policyName(ctx, record);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    if (refuseEcs(ctx, this.displayName)) return null;
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS);
    const order = countSetting(ctx, this.displayName, 'processingorder', 'ProcessingOrder', UINT32_MAXIMUM);
    if (condition === null || order === null) return null;
    const zone = zoneArgument(ctx, 0) ?? record?.zone ?? null;
    const content = contentArgument(ctx, zone === null ? 'recursionscope' : 'zonescope') ?? (record === null ? undefined : record.content);
    const result = dns.changeQueryResolutionPolicy(zone, name, {
      condition: condition ?? record?.condition ?? undefined,
      processingOrder: order ?? record?.processingOrder ?? undefined,
      criteria: mergedCriteria(criteriaFromNamed(ctx), record),
      content: content === undefined || content.length === 0 ? undefined : content,
    });
    if (!result.ok) return failed(ctx, this.displayName, result);
    const changed = viewOf(dns, zone, name);
    return isSwitchOn(ctx.named['passthru']) && changed !== undefined ? policyObject(changed) : null;
  }
}

export class RemoveDnsServerQueryResolutionPolicyCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverqueryresolutionpolicy';
  readonly displayName = 'Remove-DnsServerQueryResolutionPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', 'Force', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx, 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx, 0);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const zone = zoneArgument(ctx, 1);
    const held = viewOf(dns, zone, name);
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.removeQueryResolutionPolicy(zone, name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? policyObject(held) : null;
  }
}
