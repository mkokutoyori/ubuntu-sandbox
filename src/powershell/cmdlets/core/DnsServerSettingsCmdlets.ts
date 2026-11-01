import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { DnsCacheSettings, DnsEdnsSettings, GlobalQueryBlock } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { formatTimeSpan, makeTimeSpan } from '@/powershell/runtime/dotnetTimeSpan';
import { rangeViolation } from '@/powershell/runtime/semantics/rangeViolation';
import { failed, isSwitchOn, requireDns, stringList, timeSpanSeconds } from './DnsServerCmdlets';

const MAX_CACHE_TTL_SECONDS = 2592000;
const MAX_LOCKING_PERCENT = 100;
const MILLISECONDS = 1000;

function cacheObject(settings: DnsCacheSettings): Record<string, PSValue> {
  return {
    MaxTTL: makeTimeSpan(settings.maxTtlSeconds * MILLISECONDS),
    MaxNegativeTTL: makeTimeSpan(settings.maxNegativeTtlSeconds * MILLISECONDS),
    MaxKBSize: settings.maxKBSize,
    EnablePollutionProtection: settings.pollutionProtection,
    LockingPercent: settings.lockingPercent,
    StoreEmptyAuthenticationResponse: settings.storeEmptyAuthenticationResponse,
    IgnorePolicies: settings.ignorePolicies,
  };
}

function refuseRange(
  ctx: CmdletContext, cmdletName: string, parameter: string, shown: string, value: number,
  minimum: number, maximum: number, format?: (bound: number) => string,
): boolean {
  const violation = rangeViolation(shown, value, minimum, maximum, format);
  if (violation === null) return false;
  ctx.emitError(`${cmdletName} : Cannot validate argument on parameter '${parameter}'. ${violation}`);
  return true;
}

function spanSetting(ctx: CmdletContext, cmdletName: string, key: string, parameter: string, minimum: number): number | undefined | null {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  const seconds = timeSpanSeconds(raw, parameter);
  const asSpan = (bound: number): string => formatTimeSpan(bound * MILLISECONDS);
  return refuseRange(ctx, cmdletName, parameter, psValueToString(raw), seconds, minimum, MAX_CACHE_TTL_SECONDS, asSpan) ? null : seconds;
}

function countSetting(ctx: CmdletContext, cmdletName: string, key: string, parameter: string, maximum: number): number | undefined | null {
  const raw = ctx.named[key];
  if (raw === undefined) return undefined;
  const value = Number(psValueToString(raw));
  return refuseRange(ctx, cmdletName, parameter, psValueToString(raw), value, 0, maximum) ? null : value;
}

function flagSetting(ctx: CmdletContext, key: string): boolean | undefined {
  const raw = ctx.named[key];
  return raw === undefined ? undefined : isSwitchOn(raw);
}

export class GetDnsServerCacheCmdlet implements ICmdlet {
  readonly name = 'get-dnsservercache';
  readonly displayName = 'Get-DnsServerCache';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    return cacheObject(requireDns(ctx, 'Get-DnsServerCache').getCacheSettings());
  }
}

export class SetDnsServerCacheCmdlet implements ICmdlet {
  readonly name = 'set-dnsservercache';
  readonly displayName = 'Set-DnsServerCache';
  readonly aliases = [] as const;
  readonly parameters = [
    'StoreEmptyAuthenticationResponse', 'MaxKBSize', 'PollutionProtection', 'ComputerName', 'LockingPercent',
    'MaxNegativeTtl', 'MaxTtl', 'PassThru', 'IgnorePolicies', 'CimSession', 'ThrottleLimit', 'AsJob',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerCache');
    const maxTtlSeconds = spanSetting(ctx, 'Set-DnsServerCache', 'maxttl', 'MaxTtl', 0);
    const maxNegativeTtlSeconds = spanSetting(ctx, 'Set-DnsServerCache', 'maxnegativettl', 'MaxNegativeTtl', 1);
    const lockingPercent = countSetting(ctx, 'Set-DnsServerCache', 'lockingpercent', 'LockingPercent', MAX_LOCKING_PERCENT);
    const maxKBSize = countSetting(ctx, 'Set-DnsServerCache', 'maxkbsize', 'MaxKBSize', Number.MAX_SAFE_INTEGER);
    if (maxTtlSeconds === null || maxNegativeTtlSeconds === null || lockingPercent === null || maxKBSize === null) return null;
    const changes: Partial<DnsCacheSettings> = {
      maxTtlSeconds, maxNegativeTtlSeconds, lockingPercent, maxKBSize,
      pollutionProtection: flagSetting(ctx, 'pollutionprotection'),
      storeEmptyAuthenticationResponse: flagSetting(ctx, 'storeemptyauthenticationresponse'),
      ignorePolicies: flagSetting(ctx, 'ignorepolicies'),
    };
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<DnsCacheSettings>;
    const result = dns.setCacheSettings(defined);
    if (!result.ok) return failed(ctx, 'Set-DnsServerCache', result);
    return isSwitchOn(ctx.named['passthru']) ? cacheObject(dns.getCacheSettings()) : null;
  }
}

function globalQueryBlockObject(block: GlobalQueryBlock): Record<string, PSValue> {
  return { Enable: block.enabled, List: [...block.list] };
}

export class GetDnsServerGlobalQueryBlockListCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverglobalqueryblocklist';
  readonly displayName = 'Get-DnsServerGlobalQueryBlockList';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    return globalQueryBlockObject(requireDns(ctx, 'Get-DnsServerGlobalQueryBlockList').getGlobalQueryBlock());
  }
}

export class SetDnsServerGlobalQueryBlockListCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverglobalqueryblocklist';
  readonly displayName = 'Set-DnsServerGlobalQueryBlockList';
  readonly aliases = [] as const;
  readonly parameters = ['Enable', 'List', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerGlobalQueryBlockList');
    const given = ctx.named['list'] ?? (ctx.positional.length > 0 ? ctx.positional : undefined);
    const result = dns.setGlobalQueryBlock({
      enabled: flagSetting(ctx, 'enable'),
      list: given === undefined ? undefined : stringList(given),
    });
    if (!result.ok) return failed(ctx, 'Set-DnsServerGlobalQueryBlockList', result);
    return isSwitchOn(ctx.named['passthru']) ? globalQueryBlockObject(dns.getGlobalQueryBlock()) : null;
  }
}

function ednsObject(settings: DnsEdnsSettings): Record<string, PSValue> {
  return {
    CacheTimeout: makeTimeSpan(settings.cacheTimeoutSeconds * MILLISECONDS),
    EnableProbes: settings.enableProbes,
    EnableReception: settings.enableReception,
  };
}

export class GetDnsServerEDnsCmdlet implements ICmdlet {
  readonly name = 'get-dnsserveredns';
  readonly displayName = 'Get-DnsServerEDns';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    return ednsObject(requireDns(ctx, 'Get-DnsServerEDns').getEdnsSettings());
  }
}

export class SetDnsServerEDnsCmdlet implements ICmdlet {
  readonly name = 'set-dnsserveredns';
  readonly displayName = 'Set-DnsServerEDns';
  readonly aliases = [] as const;
  readonly parameters = ['CacheTimeout', 'EnableProbes', 'EnableReception', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerEDns');
    const raw = ctx.named['cachetimeout'];
    const result = dns.setEdnsSettings({
      cacheTimeoutSeconds: raw === undefined ? undefined : timeSpanSeconds(raw, 'CacheTimeout'),
      enableProbes: flagSetting(ctx, 'enableprobes'),
      enableReception: flagSetting(ctx, 'enablereception'),
    });
    if (!result.ok) return failed(ctx, 'Set-DnsServerEDns', result);
    return isSwitchOn(ctx.named['passthru']) ? ednsObject(dns.getEdnsSettings()) : null;
  }
}
