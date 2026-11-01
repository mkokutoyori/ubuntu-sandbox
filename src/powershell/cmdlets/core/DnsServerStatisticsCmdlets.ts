import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { ServerStatisticsSnapshot, StatisticsTimes, ZoneStatisticsSnapshot } from '@/powershell/providers/PSProviders';
import { mayProceed } from '../confirmation';
import { failed, isSwitchOn, missing, requireDns, stringList } from './DnsServerCmdlets';

function timeObject(times: StatisticsTimes): Record<string, PSValue> {
  return {
    TimeElapsedSinceServerStartBetweenRestart: times.uptimeSeconds,
    TimeElapsedSinceLastClearedStatisticsBetweenRestart: times.uptimeSecondsAtLastClear,
    TimeElapsedSinceServerStart: times.secondsSinceServerStart,
    TimeElapsedSinceLastClearedStatistics: times.secondsSinceLastClear,
    ServerStartTime: new Date(times.serverStartedAtMs),
    LastClearTime: new Date(times.lastClearedAtMs),
  };
}

function serverObject(snapshot: ServerStatisticsSnapshot): Record<string, PSValue> {
  const out: Record<string, PSValue> = { TimeStatistics: timeObject(snapshot.times) };
  for (const [group, counters] of Object.entries(snapshot.groups)) out[group] = { ...counters };
  return out;
}

function zoneObject(zone: ZoneStatisticsSnapshot): Record<string, PSValue> {
  return {
    Name: zone.name,
    StatsCollectionStartTime: new Date(zone.startedAtMs),
    ZoneQueryStatistics: zone.queries.map(query => ({
      RecordType: query.recordType,
      QueriesResponded: query.responded,
      QueriesReceived: query.received,
      QueriesFailure: query.failure,
      QueriesNameError: query.nameError,
    })),
    ZoneTransferStatistics: zone.transfers.map(transfer => ({
      TransferType: transfer.kind,
      RequestReceived: transfer.requestReceived,
      RequestSent: transfer.requestSent,
      ResponseReceived: transfer.responseReceived,
      SuccessReceived: transfer.successReceived,
      SuccessSent: transfer.successSent,
    })),
    ZoneUpdateStatistics: {
      DynamicUpdateReceived: zone.update.received,
      DynamicUpdateRejected: zone.update.rejected,
    },
  };
}

export class GetDnsServerStatisticsCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverstatistics';
  readonly displayName = 'Get-DnsServerStatistics';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Clear', 'ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;
  readonly switchParameters = ['Clear', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zones = stringList(ctx.named['zonename']);
    const clear = isSwitchOn(ctx.named['clear']);
    if (zones.length === 0) return clear ? missing(ctx, this.displayName, 'ZoneName') : serverObject(dns.getStatistics());
    const result = dns.getZoneStatistics(zones, clear);
    return result.ok ? result.zones.map(zoneObject) : failed(ctx, this.displayName, result);
  }
}

export class ClearDnsServerStatisticsCmdlet implements ICmdlet {
  readonly name = 'clear-dnsserverstatistics';
  readonly displayName = 'Clear-DnsServerStatistics';
  readonly aliases = [] as const;
  readonly parameters = ['ZoneName', 'Force', 'ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'] as const;
  readonly switchParameters = ['Force', 'AsJob'] as const;
  readonly supportsShouldProcess = true as const;

  whatIfTarget(ctx: CmdletContext): string {
    const zones = stringList(ctx.named['zonename']);
    return zones.length === 0 ? requireDns(ctx, this.displayName).serverName() : zones.join(',');
  }

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, this.displayName);
    const zones = stringList(ctx.named['zonename']);
    if (!isSwitchOn(ctx.named['force']) && !mayProceed(ctx, this.displayName, 'High')) return null;
    if (zones.length === 0) {
      dns.clearStatistics();
      return null;
    }
    const result = dns.clearZoneStatistics(zones);
    return result.ok ? null : failed(ctx, this.displayName, result);
  }
}
