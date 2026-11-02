import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, missing, requireDns } from './DnsServerCmdlets';

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

const LEVELS = ['Zone', 'Server'] as const;

function argument(ctx: CmdletContext, key: string, position: number): string | undefined {
  const given = ctx.named[key] ?? ctx.positional[position];
  return given === undefined || given === null || psValueToString(given) === '' ? undefined : psValueToString(given);
}

function changeState(ctx: CmdletContext, cmdletName: string, enabled: boolean): PSValue {
  const dns = requireDns(ctx, cmdletName);
  const level = choice(ctx, cmdletName, 'Level', 'level', LEVELS, 0);
  if (level === null) return null;
  if (level === undefined) return missing(ctx, cmdletName, 'Level');
  const zone = argument(ctx, 'zonename', 2);
  if (level === 'Zone' && zone === undefined) return missing(ctx, cmdletName, 'ZoneName');
  if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, cmdletName, 'High')) return null;
  const result = dns.setPolicyEnabled(level === 'Zone' ? zone ?? null : null, argument(ctx, 'name', 1) ?? null, enabled);
  return result.ok ? null : failed(ctx, cmdletName, result);
}

export class EnableDnsServerPolicyCmdlet implements ICmdlet {
  readonly name = 'enable-dnsserverpolicy';
  readonly displayName = 'Enable-DnsServerPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Level', 'Name', 'ZoneName', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return argument(ctx, 'name', 1) ?? psValueToString(ctx.named['level'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    return changeState(ctx, this.displayName, true);
  }
}

export class DisableDnsServerPolicyCmdlet implements ICmdlet {
  readonly name = 'disable-dnsserverpolicy';
  readonly displayName = 'Disable-DnsServerPolicy';
  readonly aliases = [] as const;
  readonly parameters = ['Level', 'Name', 'ZoneName', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return argument(ctx, 'name', 1) ?? psValueToString(ctx.named['level'] ?? ctx.positional[0] ?? '');
  }

  execute(ctx: CmdletContext): PSValue {
    return changeState(ctx, this.displayName, false);
  }
}
