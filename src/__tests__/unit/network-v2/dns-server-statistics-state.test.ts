/*
 * Structure — the state behind Get-DnsServerStatistics: the 20 counter groups and their members in the order of the
 * Windows DNS PowerShell provider classes (DnsServerQueryStatistics … DnsServerRRLStatistics, 362 counters, uint32 so
 * they wrap at 2^32), the time statistics of [MS-DNSP] DNSSRV_TIME_STATS (seconds since the server started and since the
 * last clear, and the same two measured from the machine restart), what clearing and restarting reset, and the per-zone
 * statistics (the 32 record types of DNS_ZONE_STATS_TYPE, AXFR and IXFR transfers, updates). Discrimination (run on the
 * tree before the change): every case falls, the module did not exist. The group RRLStatistics and the rate counters of a
 * zone came later: on the tree before that addition 10 of the 67 cases fall (the 20 groups, the members of RRLStatistics,
 * and eight about the rate counters of a zone: its start, the four verdicts, the snapshot, the clearing of one zone and the
 * survival of a clear of the server); the other 57 pass either way as NON-REGRESSION.
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import {
  DnsServerStatistics, SERVER_STATISTICS, ZONE_RECORD_TYPES, ZONE_TRANSFER_KINDS, zoneRecordType,
  type StatisticsClock, type StatisticsGroup,
} from '@/network/devices/windows/server/dns/DnsServerStatistics';

class FakeClock implements StatisticsClock {
  constructor(public wallMs: number, public bootMs: number) {}
  now(): number { return this.wallMs; }
  uptimeMs(): number { return this.wallMs - this.bootMs; }
}

const BOOT = 1_700_000_000_000;

describe('the counter table', () => {
  it('lists the 20 groups in the order of the provider classes', () => {
    expect(Object.keys(SERVER_STATISTICS)).toEqual([
      'QueryStatistics', 'Query2Statistics', 'RecursionStatistics', 'DnssecStatistics', 'MasterStatistics', 'SecondaryStatistics',
      'WinsStatistics', 'UpdateStatistics', 'SecurityStatistics', 'DsStatistics', 'MemoryStatistics', 'TimeoutStatistics',
      'DatabaseStatistics', 'RecordStatistics', 'PacketStatistics', 'NetBiosStatistics', 'PrivateStatistics', 'ErrorStatistics',
      'CacheStatistics', 'RRLStatistics',
    ]);
    expect(Object.values(SERVER_STATISTICS).reduce((total, counters) => total + counters.length, 0)).toBe(362);
  });

  it.each([
    ['QueryStatistics', ['UdpQueries', 'UdpResponses', 'UdpQueriesSent', 'UdpResponsesReceived', 'TcpClientConnections', 'TcpQueries', 'TcpResponses', 'TcpQueriesSent', 'TcpResponsesReceived']],
    ['DnssecStatistics', ['SuccessfulValidations', 'FailedValidations', 'RecursionFailures']],
    ['WinsStatistics', ['WinsLookups', 'WinsResponses', 'WinsReverseLookups', 'WinsReverseResponses']],
    ['CacheStatistics', ['SuccessfulFreePasses', 'FailedFreePasses', 'PassesWithNoFrees', 'PassesRequiringAggressiveFree']],
    ['RRLStatistics', ['TotalResponsesSent', 'TotalResponsesDropped', 'TotalResponsesLeaked', 'TotalResponsesTruncated']],
  ] as const)('keeps the members of %s in the class order', (group, members) => {
    expect([...SERVER_STATISTICS[group]]).toEqual(members);
  });

  it('starts every counter at zero', () => {
    const clock = new FakeClock(BOOT + 10_000, BOOT);
    const { groups } = new DnsServerStatistics(clock).snapshot();
    for (const counters of Object.values(groups)) expect(Object.values(counters).every(value => value === 0)).toBe(true);
    for (const group of Object.keys(SERVER_STATISTICS) as StatisticsGroup[]) expect(Object.keys(groups[group])).toEqual([...SERVER_STATISTICS[group]]);
  });
});

describe('counters', () => {
  it('adds one by default and by the given amount', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.add('QueryStatistics', 'UdpQueries');
    stats.add('QueryStatistics', 'UdpQueries', 4);
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(5);
    expect(stats.get('QueryStatistics', 'TcpQueries')).toBe(0);
    expect(stats.snapshot().groups.QueryStatistics.UdpQueries).toBe(5);
  });

  it('keeps the same name in two groups apart', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.add('MasterStatistics', 'Refused');
    stats.add('ErrorStatistics', 'Refused', 2);
    expect(stats.get('MasterStatistics', 'Refused')).toBe(1);
    expect(stats.get('ErrorStatistics', 'Refused')).toBe(2);
  });

  it('wraps at 2^32 like a uint32', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.add('QueryStatistics', 'UdpQueries', 0xFFFFFFFF);
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(0xFFFFFFFF);
    stats.add('QueryStatistics', 'UdpQueries', 2);
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(1);
  });

  it('counts a given exchange and tag only the first time', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    const exchange = {};
    expect([stats.firstOf(exchange, 'a'), stats.firstOf(exchange, 'a'), stats.firstOf(exchange, 'b'), stats.firstOf({}, 'a')])
      .toEqual([true, false, true, true]);
  });
});

describe('gauges', () => {
  it('read the live value instead of a counter, in the snapshot and with get', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    let cached = 3;
    stats.gauge('RecordStatistics', 'CacheCurrent', () => cached);
    expect(stats.get('RecordStatistics', 'CacheCurrent')).toBe(3);
    cached = 8;
    expect(stats.snapshot().groups.RecordStatistics.CacheCurrent).toBe(8);
    expect(stats.snapshot().groups.RecordStatistics.CacheTotal).toBe(0);
  });

  it('survive a clear and a restart, and wrap at 2^32 like the counters', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.gauge('RecordStatistics', 'CacheCurrent', () => 0x100000005);
    stats.add('RecordStatistics', 'CacheCurrent', 7);
    stats.clear();
    stats.restart();
    expect(stats.get('RecordStatistics', 'CacheCurrent')).toBe(5);
  });
});

describe('the time statistics', () => {
  it('measures the server uptime and the uptime of the machine apart', () => {
    const clock = new FakeClock(BOOT + 600_000, BOOT);
    const stats = new DnsServerStatistics(clock);
    clock.wallMs += 90_500;
    expect(stats.times()).toEqual({
      serverStartedAtMs: BOOT + 600_000,
      lastClearedAtMs: BOOT + 600_000,
      secondsSinceServerStart: 90,
      secondsSinceLastClear: 90,
      uptimeSeconds: 690,
      uptimeSecondsAtLastClear: 600,
    });
  });

  it('moves the last clear forward without touching the server start', () => {
    const clock = new FakeClock(BOOT + 600_000, BOOT);
    const stats = new DnsServerStatistics(clock);
    clock.wallMs += 100_000;
    stats.add('QueryStatistics', 'UdpQueries');
    stats.clear();
    clock.wallMs += 30_000;
    expect(stats.times()).toEqual({
      serverStartedAtMs: BOOT + 600_000,
      lastClearedAtMs: BOOT + 700_000,
      secondsSinceServerStart: 130,
      secondsSinceLastClear: 30,
      uptimeSeconds: 730,
      uptimeSecondsAtLastClear: 700,
    });
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(0);
  });

  it('restarts both the server start and the counters', () => {
    const clock = new FakeClock(BOOT + 600_000, BOOT);
    const stats = new DnsServerStatistics(clock);
    stats.add('QueryStatistics', 'UdpQueries');
    stats.trackZone('corp.test');
    clock.wallMs += 100_000;
    stats.restart();
    clock.wallMs += 5_000;
    expect(stats.times()).toMatchObject({ serverStartedAtMs: BOOT + 700_000, secondsSinceServerStart: 5, secondsSinceLastClear: 5, uptimeSecondsAtLastClear: 700 });
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(0);
    expect(stats.hasZone('corp.test')).toBe(false);
  });

  it('never reports a negative duration and wraps the seconds at 2^32', () => {
    const clock = new FakeClock(BOOT, BOOT);
    const stats = new DnsServerStatistics(clock);
    clock.wallMs -= 5_000;
    expect(stats.times()).toMatchObject({ secondsSinceServerStart: 0, secondsSinceLastClear: 0 });
    clock.wallMs = BOOT + (0x100000000 + 7) * 1000;
    expect(stats.times()).toMatchObject({ secondsSinceServerStart: 7, uptimeSeconds: 7 });
  });
});

describe('the record types of the zone statistics', () => {
  it.each([
    [RRType.A, 'A'], [RRType.AAAA, 'AAAA'], [RRType.PTR, 'PTR'], [RRType.CNAME, 'CNAME'], [RRType.MX, 'MX'], [18, 'AFSDB'],
    [34, 'ATMA'], [RRType.DHCID, 'DHCID'], [39, 'DNAME'], [13, 'HINFO'], [20, 'ISDN'], [8, 'MG'], [7, 'MB'], [14, 'MINFO'],
    [35, 'NAPTR'], [30, 'NXT'], [25, 'KEY'], [9, 'MR'], [17, 'RP'], [21, 'RT'], [RRType.SRV, 'SRV'], [24, 'SIG'],
    [RRType.TXT, 'TEXT'], [11, 'WKS'], [19, 'X25'], [RRType.DNSKEY, 'DNSKEY'], [RRType.DS, 'DS'], [RRType.NS, 'NS'],
    [RRType.SOA, 'SOA'], [52, 'TLSA'], [RRType.ANY, 'ALL'],
  ])('puts type %i under %s', (qtype, label) => {
    expect(zoneRecordType(qtype)).toBe(label);
  });

  it.each([[10], [0], [RRType.RRSIG], [RRType.NSEC], [RRType.AXFR], [65280]])('puts type %i under OTHERS', (qtype) => {
    expect(zoneRecordType(qtype)).toBe('OTHERS');
  });

  it('lists 32 labels in the order of DNS_ZONE_STATS_TYPE and two transfer kinds', () => {
    expect(ZONE_RECORD_TYPES).toHaveLength(32);
    expect(ZONE_RECORD_TYPES.slice(0, 5)).toEqual(['A', 'AAAA', 'PTR', 'CNAME', 'MX']);
    expect(ZONE_RECORD_TYPES.slice(-3)).toEqual(['TLSA', 'ALL', 'OTHERS']);
    expect(ZONE_TRANSFER_KINDS).toEqual(['AXFR', 'IXFR']);
  });
});

describe('the zone statistics', () => {
  it('starts a zone at the time it is tracked and answers null for an unknown zone', () => {
    const clock = new FakeClock(BOOT, BOOT);
    const stats = new DnsServerStatistics(clock);
    clock.wallMs += 42_000;
    stats.trackZone('corp.test');
    clock.wallMs += 10_000;
    stats.trackZone('corp.test');
    const zone = stats.zoneSnapshot('corp.test')!;
    expect(zone.startedAtMs).toBe(BOOT + 42_000);
    expect(zone.queries.map(query => query.recordType)).toEqual([...ZONE_RECORD_TYPES]);
    expect(zone.queries.every(query => query.received === 0 && query.responded === 0 && query.failure === 0 && query.nameError === 0)).toBe(true);
    expect(zone.transfers.map(transfer => transfer.kind)).toEqual(['AXFR', 'IXFR']);
    expect(zone.update).toEqual({ received: 0, rejected: 0 });
    expect(zone.rate).toEqual({ sent: 0, dropped: 0, leaked: 0, truncated: 0 });
    expect(stats.zoneSnapshot('other.test')).toBeNull();
  });

  it.each([
    ['answered', { received: 1, responded: 1, failure: 0, nameError: 0 }],
    ['nameError', { received: 1, responded: 1, failure: 0, nameError: 1 }],
    ['failure', { received: 1, responded: 1, failure: 1, nameError: 0 }],
  ] as const)('counts a %s query', (outcome, expected) => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.zoneQuery('corp.test', 'MX', outcome);
    const queries = stats.zoneSnapshot('corp.test')!.queries;
    expect(queries.find(query => query.recordType === 'MX')).toMatchObject(expected);
    expect(queries.filter(query => query.received > 0)).toHaveLength(1);
  });

  it('counts transfers and updates per zone and per kind', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.zoneTransfer('corp.test', 'IXFR', 'requestReceived');
    stats.zoneTransfer('corp.test', 'IXFR', 'successSent');
    stats.zoneTransfer('corp.test', 'AXFR', 'requestSent');
    stats.zoneUpdate('corp.test', false);
    stats.zoneUpdate('corp.test', true);
    stats.zoneUpdate('other.test', true);
    const zone = stats.zoneSnapshot('corp.test')!;
    expect(zone.transfers[0]).toEqual({ kind: 'AXFR', requestReceived: 0, requestSent: 1, responseReceived: 0, successReceived: 0, successSent: 0 });
    expect(zone.transfers[1]).toEqual({ kind: 'IXFR', requestReceived: 1, requestSent: 0, responseReceived: 0, successReceived: 0, successSent: 1 });
    expect(zone.update).toEqual({ received: 2, rejected: 1 });
    expect(stats.zoneSnapshot('other.test')!.update).toEqual({ received: 1, rejected: 1 });
  });

  it.each([
    ['send', { sent: 1, dropped: 0, leaked: 0, truncated: 0 }],
    ['drop', { sent: 0, dropped: 1, leaked: 0, truncated: 0 }],
    ['leak', { sent: 0, dropped: 0, leaked: 1, truncated: 0 }],
    ['truncate', { sent: 0, dropped: 0, leaked: 0, truncated: 1 }],
  ] as const)('counts a %s verdict of rate limiting in its own field of its own zone', (verdict, expected) => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.zoneRate('corp.test', verdict);
    stats.trackZone('other.test');
    expect(stats.zoneSnapshot('corp.test')!.rate).toEqual(expected);
    expect(stats.zoneSnapshot('other.test')!.rate).toEqual({ sent: 0, dropped: 0, leaked: 0, truncated: 0 });
  });

  it('hands out a snapshot of the rate counters that later counts do not change', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.zoneRate('corp.test', 'send');
    const before = stats.zoneSnapshot('corp.test')!;
    stats.zoneRate('corp.test', 'send');
    stats.zoneRate('corp.test', 'drop');
    expect(before.rate).toEqual({ sent: 1, dropped: 0, leaked: 0, truncated: 0 });
    expect(stats.zoneSnapshot('corp.test')!.rate).toEqual({ sent: 2, dropped: 1, leaked: 0, truncated: 0 });
  });

  it('clears one zone at a new start time and forgets another', () => {
    const clock = new FakeClock(BOOT, BOOT);
    const stats = new DnsServerStatistics(clock);
    stats.zoneQuery('corp.test', 'A', 'answered');
    stats.zoneQuery('other.test', 'A', 'answered');
    stats.zoneRate('corp.test', 'drop');
    clock.wallMs += 9_000;
    stats.clearZone('corp.test');
    stats.forgetZone('other.test');
    const zone = stats.zoneSnapshot('corp.test')!;
    expect(zone.startedAtMs).toBe(BOOT + 9_000);
    expect(zone.queries.every(query => query.received === 0)).toBe(true);
    expect(zone.rate).toEqual({ sent: 0, dropped: 0, leaked: 0, truncated: 0 });
    expect(stats.hasZone('other.test')).toBe(false);
  });

  it('leaves the zone statistics alone when the server statistics are cleared', () => {
    const stats = new DnsServerStatistics(new FakeClock(BOOT, BOOT));
    stats.zoneQuery('corp.test', 'A', 'answered');
    stats.zoneRate('corp.test', 'send');
    stats.add('QueryStatistics', 'UdpQueries');
    stats.clear();
    expect(stats.zoneSnapshot('corp.test')!.queries[0].received).toBe(1);
    expect(stats.zoneSnapshot('corp.test')!.rate.sent).toBe(1);
    expect(stats.get('QueryStatistics', 'UdpQueries')).toBe(0);
  });
});
