import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ResponseRateLimitingChanges, ResponseRateLimitingSettings } from '@/powershell/providers/PSProviders';
import type { RateLimits } from '@/network/dns/rrl/ResponseRateLimiter';
import { RESPONSE_RATE_LIMITING_MODES } from '@/network/devices/windows/server/dns/DnsResponseRateLimiting';
import { mayProceed } from '../confirmation';
import { choice, failed, isSwitchOn, requireDns } from './DnsServerCmdlets';
import { countSetting } from './DnsServerSettingsCmdlets';

const UINT32_MAXIMUM = 4294967295;

const COMMON_PARAMETERS = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

const RATE_PARAMETERS: ReadonlyArray<readonly [keyof RateLimits, string, string]> = [
  ['responsesPerSecond', 'responsespersec', 'ResponsesPerSec'],
  ['errorsPerSecond', 'errorspersec', 'ErrorsPerSec'],
  ['windowSeconds', 'windowinsec', 'WindowInSec'],
  ['ipv4PrefixLength', 'ipv4prefixlength', 'IPv4PrefixLength'],
  ['ipv6PrefixLength', 'ipv6prefixlength', 'IPv6PrefixLength'],
  ['leakRate', 'leakrate', 'LeakRate'],
  ['truncateRate', 'truncaterate', 'TruncateRate'],
  ['maximumResponsesPerWindow', 'maximumresponsesperwindow', 'MaximumResponsesPerWindow'],
];

function rateLimitingObject(settings: ResponseRateLimitingSettings): Record<string, PSValue> {
  return {
    ResponsesPerSec: settings.responsesPerSecond,
    ErrorsPerSec: settings.errorsPerSecond,
    WindowInSec: settings.windowSeconds,
    IPv4PrefixLength: settings.ipv4PrefixLength,
    IPv6PrefixLength: settings.ipv6PrefixLength,
    LeakRate: settings.leakRate,
    TruncateRate: settings.truncateRate,
    MaximumResponsesPerWindow: settings.maximumResponsesPerWindow,
    Mode: settings.mode,
  };
}

export class GetDnsServerResponseRateLimitingCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverresponseratelimiting';
  readonly displayName = 'Get-DnsServerResponseRateLimiting';
  readonly aliases = ['get-dnsserverrrl'] as const;
  readonly parameters = [...COMMON_PARAMETERS, 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    return rateLimitingObject(requireDns(ctx, this.displayName).getResponseRateLimiting());
  }
}

export class SetDnsServerResponseRateLimitingCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverresponseratelimiting';
  readonly displayName = 'Set-DnsServerResponseRateLimiting';
  readonly aliases = ['set-dnsserverrrl'] as const;
  readonly parameters = [
    'ResponsesPerSec', 'ErrorsPerSec', 'WindowInSec', 'IPv4PrefixLength', 'IPv6PrefixLength', 'LeakRate', 'ResetToDefault',
    'TruncateRate', 'MaximumResponsesPerWindow', 'Mode', 'PassThru', 'Force', ...COMMON_PARAMETERS, 'WhatIf', 'Confirm',
  ] as const;
  readonly switchParameters = ['ResetToDefault', 'PassThru', 'Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;
  readonly pipelineByPropertyName = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    return requireDns(ctx, this.displayName).serverName();
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const limits: Partial<Record<keyof RateLimits, number>> = {};
    for (const [field, key, parameter] of RATE_PARAMETERS) {
      const value = countSetting(ctx, this.displayName, key, parameter, UINT32_MAXIMUM);
      if (value === null) return null;
      if (value !== undefined) limits[field] = value;
    }
    const mode = choice(ctx, this.displayName, 'Mode', 'mode', RESPONSE_RATE_LIMITING_MODES);
    if (mode === null) return null;
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'Medium')) return null;
    const changes: ResponseRateLimitingChanges = { ...limits, mode: mode ?? 'Enable', resetToDefault: isSwitchOn(ctx.named['resettodefault']) };
    const result = dns.setResponseRateLimiting(changes);
    if (!result.ok) return failed(ctx, this.displayName, result);
    return isSwitchOn(ctx.named['passthru']) ? rateLimitingObject(dns.getResponseRateLimiting()) : null;
  }
}
