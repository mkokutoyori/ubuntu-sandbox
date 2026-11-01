/*
 * Structure — how Get-DnsServerStatistics turns the statistics of the server and of a zone into PowerShell objects: the
 * server object opens with TimeStatistics (the six members of DnsServerTimeStatistics, each read from its own measure:
 * seconds since the server started and since the last clear, the same two measured from the machine restart, and the two
 * dates) and continues with the groups in the order of the provider classes; a zone object carries its name, its
 * collection start time, a row per record type with the four members of DnsServerZoneQueryStatistics, a row per transfer
 * type with the five members of DnsServerZoneTransferStatistics and the two of DnsServerZoneUpdateStatistics. Every number
 * of the stubs is different, so two members read from each other's field cannot give the same object. -Clear is passed to
 * the provider only when asked for, and a refused zone list is reported with the provider's message.
 * Discrimination (run on the tree before the change): every case falls, the cmdlet did not exist.
 */
import { describe, it, expect } from 'vitest';
import type { CmdletContext } from '@/powershell/cmdlets/CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { GetDnsServerStatisticsCmdlet } from '@/powershell/cmdlets/core/DnsServerStatisticsCmdlets';
import {
  SERVER_STATISTICS, type ServerStatisticsSnapshot, type StatisticsGroup, type StatisticsTimes, type ZoneStatisticsSnapshot,
} from '@/network/devices/windows/server/dns/DnsServerStatistics';
import type { DnsZoneStatisticsResult } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';

const TIMES: StatisticsTimes = {
  serverStartedAtMs: 1_700_000_000_000,
  lastClearedAtMs: 1_700_000_030_000,
  secondsSinceServerStart: 45,
  secondsSinceLastClear: 15,
  uptimeSeconds: 145,
  uptimeSecondsAtLastClear: 130,
};

const ZONE: ZoneStatisticsSnapshot = {
  name: 'corp.test',
  startedAtMs: 1_700_000_010_000,
  queries: [
    { recordType: 'A', received: 7, responded: 5, failure: 3, nameError: 2 },
    { recordType: 'TEXT', received: 17, responded: 15, failure: 13, nameError: 12 },
  ],
  transfers: [
    { kind: 'AXFR', requestReceived: 11, requestSent: 12, responseReceived: 13, successReceived: 14, successSent: 15 },
    { kind: 'IXFR', requestReceived: 21, requestSent: 22, responseReceived: 23, successReceived: 24, successSent: 25 },
  ],
  update: { received: 31, rejected: 4 },
};

function serverSnapshot(): ServerStatisticsSnapshot {
  const groups = {} as Record<StatisticsGroup, Record<string, number>>;
  let next = 1;
  for (const group of Object.keys(SERVER_STATISTICS) as StatisticsGroup[]) {
    groups[group] = Object.fromEntries(SERVER_STATISTICS[group].map(counter => [counter, next++]));
  }
  return { times: TIMES, groups };
}

interface Lab {
  readonly ctx: CmdletContext;
  readonly errors: string[];
  readonly requested: Array<{ names: readonly string[]; clear: boolean }>;
}

function lab(named: Record<string, PSValue>, zoneResult: DnsZoneStatisticsResult = { ok: true, message: '', zones: [ZONE] }): Lab {
  const errors: string[] = [];
  const requested: Array<{ names: readonly string[]; clear: boolean }> = [];
  const dns = {
    getStatistics: () => serverSnapshot(),
    getZoneStatistics: (names: readonly string[], clear: boolean) => {
      requested.push({ names, clear });
      return zoneResult;
    },
  };
  const ctx = { named, providers: { dns }, emitError: (message: string) => { errors.push(message); } } as unknown as CmdletContext;
  return { ctx, errors, requested };
}

const run = (named: Record<string, PSValue>, zoneResult?: DnsZoneStatisticsResult) => {
  const stub = lab(named, zoneResult);
  return { ...stub, result: new GetDnsServerStatisticsCmdlet().execute(stub.ctx) };
};

describe('the server object', () => {
  it('opens with the time group and continues with the groups in the order of the provider classes', () => {
    const { result } = run({});
    expect(Object.keys(result as Record<string, PSValue>)).toEqual(['TimeStatistics', ...Object.keys(SERVER_STATISTICS)]);
  });

  it('reads each member of the time group from its own measure', () => {
    const { result } = run({});
    expect((result as Record<string, PSValue>).TimeStatistics).toEqual({
      TimeElapsedSinceServerStartBetweenRestart: 145,
      TimeElapsedSinceLastClearedStatisticsBetweenRestart: 130,
      TimeElapsedSinceServerStart: 45,
      TimeElapsedSinceLastClearedStatistics: 15,
      ServerStartTime: new Date(1_700_000_000_000),
      LastClearTime: new Date(1_700_000_030_000),
    });
  });

  it('carries every counter of every group under its own name', () => {
    const { result } = run({});
    const expected = serverSnapshot().groups;
    for (const group of Object.keys(SERVER_STATISTICS) as StatisticsGroup[]) {
      expect((result as Record<string, PSValue>)[group]).toEqual(expected[group]);
    }
  });

  it('refuses -Clear without a zone name and says which parameter is missing', () => {
    const { result, errors } = run({ clear: true });
    expect(result).toBeNull();
    expect(errors).toEqual(['Get-DnsServerStatistics : Cannot process command because of one or more missing mandatory parameters: ZoneName.']);
  });
});

describe('the zone object', () => {
  it('carries the name, the start of the collection and the three tables with the members of the provider classes', () => {
    const { result } = run({ zonename: 'corp.test' });
    expect(result).toEqual([{
      Name: 'corp.test',
      StatsCollectionStartTime: new Date(1_700_000_010_000),
      ZoneQueryStatistics: [
        { RecordType: 'A', QueriesResponded: 5, QueriesReceived: 7, QueriesFailure: 3, QueriesNameError: 2 },
        { RecordType: 'TEXT', QueriesResponded: 15, QueriesReceived: 17, QueriesFailure: 13, QueriesNameError: 12 },
      ],
      ZoneTransferStatistics: [
        { TransferType: 'AXFR', RequestReceived: 11, RequestSent: 12, ResponseReceived: 13, SuccessReceived: 14, SuccessSent: 15 },
        { TransferType: 'IXFR', RequestReceived: 21, RequestSent: 22, ResponseReceived: 23, SuccessReceived: 24, SuccessSent: 25 },
      ],
      ZoneUpdateStatistics: { DynamicUpdateReceived: 31, DynamicUpdateRejected: 4 },
    }]);
  });

  it('asks the provider for the listed zones and passes -Clear only when it was given', () => {
    const plain = run({ zonename: ['corp.test', 'two.test'] });
    expect(plain.requested).toEqual([{ names: ['corp.test', 'two.test'], clear: false }]);
    const cleared = run({ zonename: 'corp.test', clear: true });
    expect(cleared.requested).toEqual([{ names: ['corp.test'], clear: true }]);
  });

  it('reports the provider message and returns nothing when a zone of the list is refused', () => {
    const { result, errors } = run({ zonename: 'nosuch.test' }, { ok: false, message: 'Zone "nosuch.test" does not exist on this server.', zones: [] });
    expect(result).toBeNull();
    expect(errors).toEqual(['Get-DnsServerStatistics : Zone "nosuch.test" does not exist on this server.']);
  });
});
