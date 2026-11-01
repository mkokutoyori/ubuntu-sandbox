import { RRType } from '@/network/dns/wire/RRType';

const COUNTER_MODULUS = 0x100000000;
const MILLISECONDS_PER_SECOND = 1000;

export const SERVER_STATISTICS = {
  QueryStatistics: [
    'UdpQueries', 'UdpResponses', 'UdpQueriesSent', 'UdpResponsesReceived', 'TcpClientConnections', 'TcpQueries',
    'TcpResponses', 'TcpQueriesSent', 'TcpResponsesReceived',
  ],
  Query2Statistics: [
    'TotalQueries', 'Standard', 'Notify', 'Update', 'TKeyNego', 'TypeA', 'TypeNs', 'TypeSoa', 'TypeMx', 'TypePtr',
    'TypeSrv', 'TypeAll', 'TypeIxfr', 'TypeAxfr', 'TypeOther',
  ],
  RecursionStatistics: [
    'ReferalPasses', 'QueriesRecursed', 'OriginalQuestionRecursed', 'AdditionalRecursed', 'TotalQuestionsRecursed',
    'Retries', 'LookupPasses', 'Forwards', 'Sends', 'Responses', 'ResponsesUnmatched', 'ResponsesMismatched',
    'ResponseFromForwarder', 'ResponseAuthoritative', 'ResponseNotAuthoritative', 'ResponseAnswer',
    'ResponseNameError', 'ResponseRCode', 'ResponseEmpty', 'ResponseDelegation', 'ResponseNonZoneData',
    'ResponseUnsecure', 'ResponseBadPacket', 'SendResponseDirect', 'ContinueCurrentRecursion',
    'ContinueCurrentLookup', 'ContinueNextLookup', 'RootNsQuery', 'RootNsResponse', 'CacheUpdateAlloc',
    'CacheUpdateResponse', 'CacheUpdateFree', 'CacheUpdateRetry', 'SuspendedQuery', 'ResumeSuspendedQuery',
    'TimedoutQueries', 'FinalTimeoutQueued', 'FinalTimeoutExpired', 'RecursionFailure', 'ServerFailure',
    'PartialFailure', 'CacheUpdateFailure', 'RecursePassFailure', 'FailureReachAuthority',
    'FailureReachPreviousResponse', 'TcpTry', 'TcpConnect', 'TcpQuery', 'TcpResponse', 'TcpDisconnect',
    'DiscardedDuplicateQueries', 'DuplicateCoalesedQueries', 'GnzLocalQuery', 'GnzRemoteQuery', 'GnzRemoteResponse',
    'GnzRemoteResponseCacheSuccess', 'GnzRemoteResponseCacheFailure', 'CacheLockingDiscards',
  ],
  DnssecStatistics: [
    'SuccessfulValidations', 'FailedValidations', 'RecursionFailures',
  ],
  MasterStatistics: [
    'NotifySent', 'Request', 'NameError', 'FormError', 'AxfrLimit', 'Refused', 'RefuseSecurity', 'RefuseShutdown',
    'RefuseLoading', 'RefuseZoneLocked', 'RefuseServerFailure', 'RefuseNotAuth', 'RefuseReadOnly', 'Failure',
    'AxfrRequest', 'AxfrSuccess', 'StubAxfrRequest', 'IxfrRequest', 'IxfrNoVersion', 'IxfrUpdateSuccess',
    'IxfrTcpRequest', 'IxfrTcpSuccess', 'IxfrAxfr', 'IxfrUdpRequest', 'IxfrUdpSuccess', 'IxfrUdpForceTcp',
    'IxfrUdpForceAxfr',
  ],
  SecondaryStatistics: [
    'NotifyReceived', 'NotifyInvalid', 'NotifyPrimary', 'NotifyNonPrimary', 'NotifyNoVersion', 'NotifyNewVersion',
    'NotifyCurrentVersion', 'NotifyOldVersion', 'NotifyMasterUnknown', 'SoaRequest', 'SoaResponse',
    'SoaResponseInvalid', 'AxfrRequest', 'AxfrResponse', 'AxfrSuccess', 'AxfrRefused', 'AxfrInvalid',
    'StubAxfrRequest', 'StubAxfrResponse', 'StubAxfrSuccess', 'StubAxfrRefused', 'StubAxfrInvalid',
    'IxfrUdpRequest', 'IxfrUdpResponse', 'IxfrUdpSuccess', 'IxfrUdpUseTcp', 'IxfrUdpUseAxfr', 'IxfrUdpWrongServer',
    'IxfrUdpNoUpdate', 'IxfrUdpNewPrimary', 'IxfrUdpFormError', 'IxfrUdpRefused', 'IxfrUdpInvalid',
    'IxfrTcpRequest', 'IxfrTcpResponse', 'IxfrTcpSuccess', 'IxfrTcpAxfr', 'IxfrTcpFormError', 'IxfrTcpRefused',
    'IxfrTcpInvalid',
  ],
  WinsStatistics: [
    'WinsLookups', 'WinsResponses', 'WinsReverseLookups', 'WinsReverseResponses',
  ],
  UpdateStatistics: [
    'Received', 'Empty', 'NoOps', 'Completed', 'Rejected', 'FormError', 'NxDomain', 'NotImplemented', 'Refused',
    'YxDomain', 'YxRRset', 'NxRRset', 'NotAuthoritative', 'NotZone', 'RefusedNonSecure', 'RefusedAccessDenied',
    'SecureSuccess', 'SecureFailure', 'SecureDsWriteFailure', 'DsSuccess', 'DsWriteFailure', 'Queued', 'Timeout',
    'InQueue', 'Forwards', 'TcpForwards', 'ForwardResponses', 'ForwardTimeouts', 'ForwardInQueue',
  ],
  SecurityStatistics: [
    'SecurityContextCreate', 'SecurityContextFree', 'SecurityContextQueue', 'SecurityContextQueueInNego',
    'SecurityContextQueueInNegoComplete', 'SecurityContextQueueLength', 'SecurityContextDequeue',
    'SecurityContextTimeout', 'SecurityPackAlloc', 'SecurityPackFree', 'SecurityTKeyInvalid', 'SecurityTKeyBadTime',
    'SecurityTSigFormError', 'SecurityTSigEcho', 'SecurityTSigBadKey', 'SecurityTSigVerifySuccess',
    'SecurityTSigVerifyFailed',
  ],
  DsStatistics: [
    'DsTotalNodesRead', 'DsTotalRecordsRead', 'DsNodesLoaded', 'DsRecordsLoaded', 'DsTombstonesRead',
    'DsUpdateSearches', 'DsUpdateNodesRead', 'DsUpdateRecordsRead', 'UpdateLists', 'UpdateNodes',
    'UpdateSuppressed', 'UpdateWrites', 'UpdateTombstones', 'UpdateRecordChange', 'UpdateAginRefresh',
    'UpdateAgingOn', 'UpdateAgingOff', 'UpdatePacket', 'UpdatePacketPrecon', 'UpdateAdmin', 'UpdateAutoConfig',
    'UpdateScavenge', 'DsNodesAdded', 'DsNodesModified', 'DsNodesTombstoned', 'DsNodesDeleted', 'DsRecordsAdded',
    'DsRecordsReplaced', 'DsWriteSuppressed', 'DsSerialWrites', 'LdapTimedWrites', 'LdapWriteTimeTotal',
    'LdapWriteAverage', 'LdapWriteMax', 'LdapWriteBucket0', 'LdapWriteBucket1', 'LdapWriteBucket2',
    'LdapWriteBucket3', 'LdapWriteBucket4', 'LdapWriteBucket5', 'LdapSearchTime', 'FailedDeleteDsEntries',
    'FailedReadRecords', 'FailedLdapModify', 'FailedLdapAdd', 'PollingPassesWithDsErrors', 'LdapReconnects',
  ],
  MemoryStatistics: [
    'Memory', 'Alloc', 'Free', 'StdUsed', 'StdReturn', 'StdInUse', 'StdMemory', 'StdToHeapAlloc', 'StdToHeapFree',
    'StdToHeapInUse', 'StdToHeapMemory', 'StdBlockAlloc', 'StdBlockUsed', 'StdBlockReturn', 'StdBlockInUse',
    'StdBlockFreeList', 'StdBlockFreeListMemory', 'StdBlockMemory',
  ],
  TimeoutStatistics: [
    'SetTotal', 'SetDirect', 'SetFromDereference', 'SetFromChildDelete', 'AlreadyInSystem', 'Checks',
    'RecentAccess', 'ActiveRecord', 'CanNotDelete', 'Deleted', 'ArrayBlocksCreated', 'ArrayBlocksDeleted',
    'DelayedFreesQueued', 'DelayedFreesQueuedWithFunction', 'DelayedFreesExecuted',
    'DelayedFreesExecutedWithFunction',
  ],
  DatabaseStatistics: [
    'NodeMemory', 'NodeInUse', 'NodeUsed', 'NodeReturn',
  ],
  RecordStatistics: [
    'InUse', 'Used', 'Return', 'Memory', 'CacheTotal', 'CacheCurrent', 'CacheTimeouts', 'SlowFreeQueued',
    'SlowFreeFinished',
  ],
  PacketStatistics: [
    'UdpAlloc', 'UdpFree', 'UdpNetAllocs', 'UdpMemory', 'UdpUsed', 'UdpReturn', 'UdpResponseReturn',
    'UdpQueryReturn', 'UdpInUse', 'UdpInFreeList', 'TcpAlloc', 'TcpFree', 'TcpNetAllocs', 'TcpMemory',
    'RecursePacketUsed', 'RecursePacketReturn', 'PacketsForNsListUsed', 'PacketsForNsListReturned',
    'PacketsForNsListInUse',
  ],
  NetBiosStatistics: [
    'NbstatAlloc', 'NbstatFree', 'NbstatNetAllocs', 'NbstatMemory', 'NbstatUsed', 'NbstatReturn', 'NbstatInUse',
    'NbstatInFreeList',
  ],
  PrivateStatistics: [
    'UdpSocketPnpDelete', 'UdpRecvFailure', 'UdpErrorMessageSize', 'UdpConnResets', 'UdpConnResetRetryOverflow',
    'UdpGQCSFailure', 'UdpGQCSFailureWithContext', 'UdpGQCSConnReset', 'UdpIndicateRecvFailures',
    'UdpRestartRecvOnSockets', 'TcpConnect', 'TcpQuery', 'TcpDisconnect', 'SecBigTimeSkewBypass', 'ZoneLoadInit',
  ],
  ErrorStatistics: [
    'NoError', 'FormError', 'ServFail', 'NxDomain', 'NotImpl', 'Refused', 'YxDomain', 'YxRRSet', 'NxRRSet',
    'NotAuthoritative', 'NotZone', 'Max', 'BadSig', 'BadKey', 'BadTime', 'UnknownError',
  ],
  CacheStatistics: [
    'SuccessfulFreePasses', 'FailedFreePasses', 'PassesWithNoFrees', 'PassesRequiringAggressiveFree',
  ],
} as const;

export type StatisticsGroup = keyof typeof SERVER_STATISTICS;

export type StatisticsCounter<G extends StatisticsGroup> = (typeof SERVER_STATISTICS)[G][number];

export const ZONE_RECORD_TYPES = [
  'A', 'AAAA', 'PTR', 'CNAME', 'MX', 'AFSDB', 'ATMA', 'DHCID', 'DNAME', 'HINFO', 'ISDN', 'MG', 'MB', 'MINFO', 'NAPTR', 'NXT',
  'KEY', 'MR', 'RP', 'RT', 'SRV', 'SIG', 'TEXT', 'WKS', 'X25', 'DNSKEY', 'DS', 'NS', 'SOA', 'TLSA', 'ALL', 'OTHERS',
] as const;

export type ZoneRecordType = (typeof ZONE_RECORD_TYPES)[number];

export const ZONE_TRANSFER_KINDS = ['AXFR', 'IXFR'] as const;

export type ZoneTransferKind = (typeof ZONE_TRANSFER_KINDS)[number];

const ZONE_RECORD_TYPE_CODES: ReadonlyMap<number, ZoneRecordType> = new Map<number, ZoneRecordType>([
  [RRType.A, 'A'], [RRType.AAAA, 'AAAA'], [RRType.PTR, 'PTR'], [RRType.CNAME, 'CNAME'], [RRType.MX, 'MX'],
  [18, 'AFSDB'], [34, 'ATMA'], [RRType.DHCID, 'DHCID'], [39, 'DNAME'], [13, 'HINFO'], [20, 'ISDN'], [8, 'MG'], [7, 'MB'],
  [14, 'MINFO'], [35, 'NAPTR'], [30, 'NXT'], [25, 'KEY'], [9, 'MR'], [17, 'RP'], [21, 'RT'], [RRType.SRV, 'SRV'], [24, 'SIG'],
  [RRType.TXT, 'TEXT'], [11, 'WKS'], [19, 'X25'], [RRType.DNSKEY, 'DNSKEY'], [RRType.DS, 'DS'], [RRType.NS, 'NS'],
  [RRType.SOA, 'SOA'], [52, 'TLSA'], [RRType.ANY, 'ALL'],
]);

export function zoneRecordType(qtype: number): ZoneRecordType {
  return ZONE_RECORD_TYPE_CODES.get(qtype) ?? 'OTHERS';
}

export interface StatisticsClock {
  now(): number;
  uptimeMs(): number;
}

export interface StatisticsTimes {
  readonly serverStartedAtMs: number;
  readonly lastClearedAtMs: number;
  readonly secondsSinceServerStart: number;
  readonly secondsSinceLastClear: number;
  readonly uptimeSeconds: number;
  readonly uptimeSecondsAtLastClear: number;
}

export interface ZoneQueryCounters {
  received: number;
  responded: number;
  failure: number;
  nameError: number;
}

export interface ZoneTransferCounters {
  requestReceived: number;
  requestSent: number;
  responseReceived: number;
  successReceived: number;
  successSent: number;
}

export interface ZoneUpdateCounters {
  received: number;
  rejected: number;
}

export type ZoneQueryOutcome = 'answered' | 'nameError' | 'failure';

export interface ZoneStatisticsSnapshot {
  readonly name: string;
  readonly startedAtMs: number;
  readonly queries: ReadonlyArray<{ readonly recordType: ZoneRecordType } & Readonly<ZoneQueryCounters>>;
  readonly transfers: ReadonlyArray<{ readonly kind: ZoneTransferKind } & Readonly<ZoneTransferCounters>>;
  readonly update: Readonly<ZoneUpdateCounters>;
}

export interface ServerStatisticsSnapshot {
  readonly times: StatisticsTimes;
  readonly groups: Readonly<Record<StatisticsGroup, Readonly<Record<string, number>>>>;
}

interface ZoneRecord {
  startedAtMs: number;
  readonly queries: Map<ZoneRecordType, ZoneQueryCounters>;
  readonly transfers: Map<ZoneTransferKind, ZoneTransferCounters>;
  update: ZoneUpdateCounters;
}

function freshQueryCounters(): ZoneQueryCounters {
  return { received: 0, responded: 0, failure: 0, nameError: 0 };
}

function freshTransferCounters(): ZoneTransferCounters {
  return { requestReceived: 0, requestSent: 0, responseReceived: 0, successReceived: 0, successSent: 0 };
}

function freshZone(startedAtMs: number): ZoneRecord {
  return {
    startedAtMs,
    queries: new Map(ZONE_RECORD_TYPES.map(type => [type, freshQueryCounters()])),
    transfers: new Map(ZONE_TRANSFER_KINDS.map(kind => [kind, freshTransferCounters()])),
    update: { received: 0, rejected: 0 },
  };
}

function wholeSeconds(milliseconds: number): number {
  return Math.floor(Math.max(0, milliseconds) / MILLISECONDS_PER_SECOND) % COUNTER_MODULUS;
}

export class DnsServerStatistics {
  private readonly counters = new Map<string, number>();
  private readonly zones = new Map<string, ZoneRecord>();
  private readonly seen = new WeakMap<object, Set<string>>();
  private serverStartedAtMs: number;
  private lastClearedAtMs: number;
  private lastClearedUptimeMs: number;

  constructor(private readonly clock: StatisticsClock) {
    this.serverStartedAtMs = clock.now();
    this.lastClearedAtMs = this.serverStartedAtMs;
    this.lastClearedUptimeMs = clock.uptimeMs();
  }

  add<G extends StatisticsGroup>(group: G, counter: StatisticsCounter<G>, amount = 1): void {
    const key = `${group}.${counter}`;
    this.counters.set(key, ((this.counters.get(key) ?? 0) + amount) % COUNTER_MODULUS);
  }

  get<G extends StatisticsGroup>(group: G, counter: StatisticsCounter<G>): number {
    return this.counters.get(`${group}.${counter}`) ?? 0;
  }

  firstOf(exchange: object, tag: string): boolean {
    const tags = this.seen.get(exchange) ?? new Set<string>();
    this.seen.set(exchange, tags);
    if (tags.has(tag)) return false;
    tags.add(tag);
    return true;
  }

  restart(): void {
    this.counters.clear();
    this.zones.clear();
    this.serverStartedAtMs = this.clock.now();
    this.markCleared();
  }

  clear(): void {
    this.counters.clear();
    this.markCleared();
  }

  private markCleared(): void {
    this.lastClearedAtMs = this.clock.now();
    this.lastClearedUptimeMs = this.clock.uptimeMs();
  }

  times(): StatisticsTimes {
    const now = this.clock.now();
    return {
      serverStartedAtMs: this.serverStartedAtMs,
      lastClearedAtMs: this.lastClearedAtMs,
      secondsSinceServerStart: wholeSeconds(now - this.serverStartedAtMs),
      secondsSinceLastClear: wholeSeconds(now - this.lastClearedAtMs),
      uptimeSeconds: wholeSeconds(this.clock.uptimeMs()),
      uptimeSecondsAtLastClear: wholeSeconds(this.lastClearedUptimeMs),
    };
  }

  snapshot(): ServerStatisticsSnapshot {
    const groups = {} as Record<StatisticsGroup, Record<string, number>>;
    for (const group of Object.keys(SERVER_STATISTICS) as StatisticsGroup[]) {
      const values: Record<string, number> = {};
      for (const counter of SERVER_STATISTICS[group]) values[counter] = this.counters.get(`${group}.${counter}`) ?? 0;
      groups[group] = values;
    }
    return { times: this.times(), groups };
  }

  trackZone(name: string): void {
    if (!this.zones.has(name)) this.zones.set(name, freshZone(this.clock.now()));
  }

  forgetZone(name: string): void {
    this.zones.delete(name);
  }

  hasZone(name: string): boolean {
    return this.zones.has(name);
  }

  clearZone(name: string): void {
    this.zones.set(name, freshZone(this.clock.now()));
  }

  zoneQuery(name: string, recordType: ZoneRecordType, outcome: ZoneQueryOutcome): void {
    const counters = this.zoneRecord(name).queries.get(recordType) as ZoneQueryCounters;
    counters.received += 1;
    counters.responded += 1;
    if (outcome === 'nameError') counters.nameError += 1;
    if (outcome === 'failure') counters.failure += 1;
  }

  zoneTransfer(name: string, kind: ZoneTransferKind, field: keyof ZoneTransferCounters): void {
    (this.zoneRecord(name).transfers.get(kind) as ZoneTransferCounters)[field] += 1;
  }

  zoneUpdate(name: string, rejected: boolean): void {
    const update = this.zoneRecord(name).update;
    update.received += 1;
    if (rejected) update.rejected += 1;
  }

  zoneSnapshot(name: string): ZoneStatisticsSnapshot | null {
    const record = this.zones.get(name);
    if (record === undefined) return null;
    return {
      name,
      startedAtMs: record.startedAtMs,
      queries: ZONE_RECORD_TYPES.map(recordType => ({ recordType, ...(record.queries.get(recordType) as ZoneQueryCounters) })),
      transfers: ZONE_TRANSFER_KINDS.map(kind => ({ kind, ...(record.transfers.get(kind) as ZoneTransferCounters) })),
      update: { ...record.update },
    };
  }

  private zoneRecord(name: string): ZoneRecord {
    this.trackZone(name);
    return this.zones.get(name) as ZoneRecord;
  }
}
