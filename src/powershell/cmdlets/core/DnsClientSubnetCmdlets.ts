import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ClientSubnetView } from '@/powershell/providers/PSProviders';
import { CLIENT_SUBNET_ACTIONS, CLIENT_SUBNET_REFUSALS } from '@/network/devices/windows/server/dns/DnsClientSubnets';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, missing, requireDns, stringList } from './DnsServerCmdlets';

function subnetList(subnets: readonly string[]): PSValue {
  return subnets.length === 0 ? null : [...subnets];
}

function subnetObject(view: ClientSubnetView): Record<string, PSValue> {
  return { Name: view.name, IPV4Subnet: subnetList(view.ipv4), IPV6Subnet: subnetList(view.ipv6) };
}

function nameArgument(ctx: CmdletContext): string {
  return psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
}

function subnetsArgument(ctx: CmdletContext, key: string, position: number): string[] {
  return stringList(ctx.named[key] ?? ctx.positional[position]);
}

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

export class AddDnsServerClientSubnetCmdlet implements ICmdlet {
  readonly name = 'add-dnsserverclientsubnet';
  readonly displayName = 'Add-DnsServerClientSubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'IPv4Subnet', 'IPv6Subnet', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    if (name === '') return missing(ctx, this.displayName, 'Name');
    const result = dns.addClientSubnet(name, subnetsArgument(ctx, 'ipv4subnet', 1), subnetsArgument(ctx, 'ipv6subnet', 2));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const created = dns.getClientSubnets().find(view => view.name === name);
    return isSwitchOn(ctx.named['passthru']) && created !== undefined ? subnetObject(created) : null;
  }
}

export class GetDnsServerClientSubnetCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverclientsubnet';
  readonly displayName = 'Get-DnsServerClientSubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Name', ...COMMON_PARAMETERS] as const;
  readonly switchParameters = ['AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    const views = dns.getClientSubnets().filter(view => name === '' || view.name.toLowerCase() === name.toLowerCase());
    if (name !== '' && views.length === 0) {
      return failed(ctx, this.displayName, { ok: false, message: CLIENT_SUBNET_REFUSALS.missing });
    }
    return views.map(subnetObject);
  }
}

export class SetDnsServerClientSubnetCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverclientsubnet';
  readonly displayName = 'Set-DnsServerClientSubnet';
  readonly aliases = [] as const;
  readonly parameters = ['Name', 'IPv4Subnet', 'IPv6Subnet', 'Action', 'PassThru', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['PassThru', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return nameArgument(ctx);
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const name = nameArgument(ctx);
    const action = choice(ctx, this.displayName, 'Action', 'action', CLIENT_SUBNET_ACTIONS);
    if (action === null) return null;
    if (name === '' || action === undefined) {
      return missing(ctx, this.displayName, [name === '' ? 'Name' : '', action === undefined ? 'Action' : ''].filter(parameter => parameter !== '').join(', '));
    }
    const result = dns.changeClientSubnet(name, action, subnetsArgument(ctx, 'ipv4subnet', 1), subnetsArgument(ctx, 'ipv6subnet', 2));
    if (!result.ok) return failed(ctx, this.displayName, result);
    const changed = dns.getClientSubnets().find(view => view.name.toLowerCase() === name.toLowerCase());
    return isSwitchOn(ctx.named['passthru']) && changed !== undefined ? subnetObject(changed) : null;
  }
}

export class RemoveDnsServerClientSubnetCmdlet implements ICmdlet {
  readonly name = 'remove-dnsserverclientsubnet';
  readonly displayName = 'Remove-DnsServerClientSubnet';
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
    const held = dns.getClientSubnets().find(view => view.name.toLowerCase() === name.toLowerCase());
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    const result = dns.removeClientSubnet(name);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) && held !== undefined ? subnetObject(held) : null;
  }
}
