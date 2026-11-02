import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IDnsServerProvider, NewPolicy, PolicyView } from '@/powershell/providers/PSProviders';
import { POLICY_ACTIONS, POLICY_REFUSALS } from '@/network/devices/windows/server/dns/DnsPolicies';
import { POLICY_CONDITIONS } from '@/network/devices/windows/server/dns/DnsPolicyCriteria';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, missing, requireDns } from './DnsServerCmdlets';
import { UINT32_MAXIMUM, countSetting } from './DnsServerSettingsCmdlets';
import {
  POLICY_CRITERIA_PARAMETERS, criteriaFromNamed, inputObject, mergedCriteria, nameArgument, policyName, policyObject, positional, zoneArgument,
} from './DnsPolicyObjects';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

const TRANSFER_CRITERIA_PARAMETERS = ['ClientSubnet', 'InternetProtocol', 'ServerInterfaceIP', 'TimeOfDay', 'TransportProtocol'] as const;

const TRANSFER_CRITERIA = POLICY_CRITERIA_PARAMETERS.filter(entry => (TRANSFER_CRITERIA_PARAMETERS as readonly string[]).includes(entry.parameter));

function transferCriteria(ctx: CmdletContext) {
  const given = criteriaFromNamed(ctx);
  return Object.fromEntries(TRANSFER_CRITERIA.flatMap(({ type }) => (given[type] === undefined ? [] : [[type, given[type]]])));
}

function viewOf(dns: IDnsServerProvider, zone: string | null, name: string): PolicyView | undefined {
  return dns.getZoneTransferPolicies(zone).policies.find(view => view.name.toLowerCase() === name.toLowerCase());
}

function placedAfterName(ctx: CmdletContext): number {
  return ctx.named['zonename'] === undefined && ctx.positional.length >= 4 ? 2 : 1;
}

export class AddDnsServerZoneTransferPolicyCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverzonetransferpolicy';
  readonly displayName = 'Add-DnsServerZoneTransferPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'ZoneName', 'Action', 'Condition', 'PassThru', 'Disable', 'ProcessingOrder', 'InputObject', ...TRANSFER_CRITERIA_PARAMETERS,
    ...COMMON_PARAMETERS, 'WhatIf', 'Confirm',
  ] as const;
  readonly switchParameters = ['PassThru', 'Disable', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly closedParameterSet = true as const;
  readonly pipelineByValue = 'InputObject';

  whatIfTarget(ctx: CmdletContext): string {
    return policyName(ctx, inputObject(ctx), 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const record = inputObject(ctx);
    const name = policyName(ctx, record, 0);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const next = placedAfterName(ctx);
    const action = choice(ctx, this.displayName, 'Action', 'action', POLICY_ACTIONS, next);
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS, next + 1);
    const order = countSetting(ctx, this.displayName, 'processingorder', 'ProcessingOrder', UINT32_MAXIMUM);
    if (action === null || condition === null || order === null) return null;
    const chosen = action ?? record?.action ?? null;
    if (chosen === null) return failed(ctx, this.displayName, { ok: false, message: POLICY_REFUSALS.invalidSettings });
    const zone = zoneArgument(ctx, next === 2 ? 1 : undefined) ?? record?.zone ?? null;
    const spec: NewPolicy = {
      name,
      kind: 'ZoneTransfer',
      action: chosen,
      condition: condition ?? record?.condition ?? 'AND',
      enabled: !isSwitchOn(ctx.named['disable']) && (record?.enabled ?? true),
      processingOrder: order,
      criteria: mergedCriteria(transferCriteria(ctx), record),
      content: [],
    };
    const result = dns.addZoneTransferPolicy(zone, spec);
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = viewOf(dns, zone, name);
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? policyObject(created) : null;
  }
}

export class GetDnsServerZoneTransferPolicyCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverzonetransferpolicy';
  readonly displayName = 'Get-DnsServerZoneTransferPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;
  readonly closedParameterSet = true as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zoneText = positional(ctx, 'zonename', 1);
    const listed = dns.getZoneTransferPolicies(zoneText === undefined || zoneText === '' ? null : zoneText);
    if (!listed.ok) return failed(ctx, this.displayName, listed);
    const name = positional(ctx, 'name', 0);
    if (name === undefined || name === '') return listed.policies.map(policyObject);
    const found = listed.policies.find(view => view.name.toLowerCase() === name.toLowerCase());
    return found === undefined ? failed(ctx, this.displayName, { ok: false, message: POLICY_REFUSALS.missing }) : policyObject(found);
  }
}

export class SetDnsServerZoneTransferPolicyCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverzonetransferpolicy';
  readonly displayName = 'Set-DnsServerZoneTransferPolicy';
  readonly aliases = [] as const;
  readonly parameters = [
    'Name', 'ZoneName', 'PassThru', 'Condition', 'ProcessingOrder', 'InputObject', ...TRANSFER_CRITERIA_PARAMETERS, ...COMMON_PARAMETERS, 'WhatIf', 'Confirm',
  ] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly closedParameterSet = true as const;
  readonly pipelineByValue = 'InputObject';

  whatIfTarget(ctx: CmdletContext): string {
    return policyName(ctx, inputObject(ctx), 0);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const record = inputObject(ctx);
    const name = policyName(ctx, record, 0);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const condition = choice(ctx, this.displayName, 'Condition', 'condition', POLICY_CONDITIONS);
    const order = countSetting(ctx, this.displayName, 'processingorder', 'ProcessingOrder', UINT32_MAXIMUM);
    if (condition === null || order === null) return null;
    const zone = zoneArgument(ctx, 1) ?? record?.zone ?? null;
    const result = dns.changeZoneTransferPolicy(zone, name, {
      condition: condition ?? record?.condition ?? undefined,
      processingOrder: order ?? record?.processingOrder ?? undefined,
      criteria: mergedCriteria(transferCriteria(ctx), record),
    });
    if (!result.ok) return failed(ctx, this.displayName, result);
    const changed = viewOf(dns, zone, name);
    return isSwitchOn(ctx.named['passthru']) && changed !== undefined ? policyObject(changed) : null;
  }
}

export class RemoveDnsServerZoneTransferPolicyCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverzonetransferpolicy';
  readonly displayName = 'Remove-DnsServerZoneTransferPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'ZoneName', 'Force', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly closedParameterSet = true as const;
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
    const result = dns.removeZoneTransferPolicy(zone, name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? policyObject(held) : null;
  }
}
