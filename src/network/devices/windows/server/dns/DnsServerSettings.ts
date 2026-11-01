import { joinMultiString, splitMultiString, type DnsServerParameters } from './DnsServerParameters';

export type DnsServerSettingKind = 'flag' | 'count' | 'span' | 'text' | 'ports' | 'sendPort';

export type DnsServerSettingValue = boolean | number | string | readonly string[] | null;

export interface DnsServerSettingSpec {
  readonly property: string;
  readonly registry: string | null;
  readonly kind: DnsServerSettingKind;
  readonly fallback: DnsServerSettingValue;
  readonly brief: boolean;
  readonly mustRange?: readonly [number, number];
}

export interface DnsServerSettingEntry {
  readonly property: string;
  readonly kind: DnsServerSettingKind;
  readonly value: DnsServerSettingValue;
  readonly brief: boolean;
}

export interface DnsServerIdentity {
  readonly computerName: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly buildNumber: number;
  readonly isReadOnlyDc: boolean;
  readonly directoryAvailable: boolean;
  readonly addresses: readonly string[];
}

const DAY_SECONDS = 86400;
const SOCKET_POOL_LIMIT = 10000;
const TCP_RECEIVE_MINIMUM = 0x4000;
const TCP_RECEIVE_MAXIMUM = 0x10000;

const flag = (property: string, registry: string, fallback: boolean, brief = false): DnsServerSettingSpec =>
  ({ property, registry, kind: 'flag', fallback, brief });
const count = (property: string, registry: string, fallback: number, brief = false, mustRange?: readonly [number, number]): DnsServerSettingSpec =>
  ({ property, registry, kind: 'count', fallback, brief, mustRange });
const span = (property: string, registry: string, fallbackSeconds: number): DnsServerSettingSpec =>
  ({ property, registry, kind: 'span', fallback: fallbackSeconds, brief: false });
const text = (property: string, registry: string, fallback: string): DnsServerSettingSpec =>
  ({ property, registry, kind: 'text', fallback, brief: false });
const computed = (property: string, kind: DnsServerSettingKind, brief: boolean): DnsServerSettingSpec =>
  ({ property, registry: null, kind, fallback: null, brief });

export const SERVER_SETTINGS: readonly DnsServerSettingSpec[] = [
  computed('ComputerName', 'text', true),
  computed('MajorVersion', 'count', true),
  computed('MinorVersion', 'count', true),
  computed('BuildNumber', 'count', true),
  computed('IsReadOnlyDC', 'flag', true),
  flag('EnableDnsSec', 'EnableDnsSec', true, true),
  flag('EnableIPv6', 'EnableIPv6', true, true),
  flag('EnableOnlineSigning', 'EnableOnlineSigning', true, true),
  count('NameCheckFlag', 'NameCheckFlag', 2, true),
  count('AddressAnswerLimit', 'AddressAnswerLimit', 0, true),
  count('XfrConnectTimeout(s)', 'XfrConnectTimeout', 30, true),
  count('BootMethod', 'BootMethod', 2, true),
  flag('AllowUpdate', 'AllowUpdate', true, true),
  count('UpdateOptions', 'UpdateOptions', 0x30F, true),
  computed('DsAvailable', 'flag', true),
  flag('DisableAutoReverseZone', 'DisableAutoReverseZones', false),
  flag('AutoCacheUpdate', 'AutoCacheUpdate', false),
  flag('RoundRobin', 'RoundRobin', true),
  flag('LocalNetPriority', 'LocalNetPriority', true),
  flag('StrictFileParsing', 'StrictFileParsing', false),
  flag('LooseWildcarding', 'LooseWildcarding', false),
  flag('BindSecondaries', 'BindSecondaries', false),
  flag('WriteAuthorityNS', 'WriteAuthorityNs', false),
  flag('ForwardDelegations', 'ForwardDelegations', false),
  count('AutoConfigFileZones', 'AutoConfigFileZones', 1),
  flag('EnableDirectoryPartitions', 'EnableDirectoryPartitions', true),
  count('RpcProtocol', 'RpcProtocol', 5),
  count('EnableVersionQuery', 'EnableVersionQuery', 0),
  flag('EnableDuplicateQuerySuppression', 'EnableDuplicateQuerySuppression', true),
  span('LameDelegationTTL', 'LameDelegationTtl', 0),
  count('AutoCreateDelegation', 'AutoCreateDelegations', 2),
  flag('AllowCnameAtNs', 'AllowCNAMEAtNS', true),
  count('RemoteIPv4RankBoost', 'RemoteIPv4RankBoost', 5, false, [0, 10]),
  count('RemoteIPv6RankBoost', 'RemoteIPv6RankBoost', 0, false, [0, 10]),
  flag('EnableRsoForRodc', 'EnableRsoForRodc', true),
  count('MaximumRodcRsoQueueLength', 'MaximumRodcRsoQueueLength', 300),
  count('MaximumRodcRsoAttemptsPerCycle', 'MaximumRodcRsoAttemptsPerCycle', 100),
  flag('OpenAclOnProxyUpdates', 'OpenACLOnProxyUpdates', true),
  flag('NoUpdateDelegations', 'NoUpdateDelegations', false),
  flag('EnableUpdateForwarding', 'EnableUpdateForwarding', false),
  count('MaxResourceRecordsInNonSecureUpdate', 'MaxResourceRecordsInNonSecureUpdate', 30),
  flag('EnableWinsR', 'EnableWinsR', true),
  count('LocalNetPriorityMask', 'LocalNetPriorityNetMask', 255),
  flag('DeleteOutsideGlue', 'DeleteOutsideGlue', false),
  flag('AppendMsZoneTransferTag', 'AppendMsZoneTransferTag', false),
  flag('AllowReadOnlyZoneTransfer', 'AllowReadOnlyZoneTransfer', false),
  count('MaximumUdpPacketSize', 'MaximumUdpPacketSize', 4000, false, [0x200, 0x4000]),
  count('TcpReceivePacketSize', 'TcpReceivePacketSize', 65536, false, [TCP_RECEIVE_MINIMUM, TCP_RECEIVE_MAXIMUM]),
  flag('EnableSendErrorSuppression', 'EnableSendErrorSuppression', true),
  count('SelfTest', 'SelfTest', 0xFFFFFFFF),
  count('XfrThrottleMultiplier', 'XfrThrottleMultiplier', 10),
  flag('SilentlyIgnoreCnameUpdateConflicts', 'SilentlyIgnoreCNameUpdateConflicts', false),
  flag('EnableIQueryResponseGeneration', 'EnableIQueryResponseGeneration', false),
  count('SocketPoolSize', 'SocketPoolSize', 2500, false, [0, SOCKET_POOL_LIMIT]),
  flag('AdminConfigured', 'AdminConfigured', true),
  { property: 'SocketPoolExcludedPortRanges', registry: 'SocketPoolExcludedPortRanges', kind: 'ports', fallback: [], brief: false },
  text('ForestDirectoryPartitionBaseName', 'ForestDirectoryPartitionBaseName', 'ForestDnsZones'),
  text('DomainDirectoryPartitionBaseName', 'DomainDirectoryPartitionBaseName', 'DomainDnsZones'),
  text('ServerLevelPluginDll', 'ServerLevelPluginDll', ''),
  { property: 'EnableRegistryBoot', registry: 'EnableRegistryBoot', kind: 'flag', fallback: null, brief: false },
  flag('PublishAutoNet', 'PublishAutonet', false),
  count('QuietRecvFaultInterval(s)', 'QuietRecvFaultInterval', 0),
  count('QuietRecvLogInterval(s)', 'QuietRecvLogInterval', 0),
  flag('ReloadException', 'ReloadException', false),
  count('SyncDsZoneSerial', 'SyncDsZoneSerial', 2),
  { property: 'SendPort', registry: 'SendPort', kind: 'sendPort', fallback: 0, brief: false },
  span('MaximumSignatureScanPeriod', 'MaximumSignatureScanPeriod', 2 * DAY_SECONDS),
  span('MaximumTrustAnchorActiveRefreshInterval', 'MaxTrustAnchorActiveRefreshInterval', 15 * DAY_SECONDS),
  computed('ListeningIPAddress', 'ports', true),
  computed('AllIPAddress', 'ports', true),
];

export function computedSettingValue(property: string, identity: DnsServerIdentity): DnsServerSettingValue {
  switch (property) {
    case 'ComputerName': return identity.computerName;
    case 'MajorVersion': return identity.majorVersion;
    case 'MinorVersion': return identity.minorVersion;
    case 'BuildNumber': return identity.buildNumber;
    case 'IsReadOnlyDC': return identity.isReadOnlyDc;
    case 'DsAvailable': return identity.directoryAvailable;
    case 'ListeningIPAddress':
    case 'AllIPAddress': return identity.addresses;
    default: return null;
  }
}

const RANDOM_SEND_PORT = 'Random';
const DIRECTORY_BOOT_METHOD = 3;

function fallbackOf(spec: DnsServerSettingSpec, identity: DnsServerIdentity): DnsServerSettingValue {
  return spec.property === 'BootMethod' && identity.directoryAvailable ? DIRECTORY_BOOT_METHOD : spec.fallback;
}

function readValue(spec: DnsServerSettingSpec, parameters: DnsServerParameters, identity: DnsServerIdentity): DnsServerSettingValue {
  if (spec.registry === null) return computedSettingValue(spec.property, identity);
  const raw = parameters.rawSetting(spec.registry);
  const fallback = fallbackOf(spec, identity);
  if (raw === undefined) return spec.kind === 'sendPort' ? RANDOM_SEND_PORT : fallback;
  switch (spec.kind) {
    case 'flag': return Number(raw) !== 0;
    case 'count':
    case 'span': return Number.isFinite(Number(raw)) ? Number(raw) : fallback;
    case 'text': return String(raw);
    case 'ports': return splitMultiString(String(raw));
    case 'sendPort': return Number(raw) === 0 ? RANDOM_SEND_PORT : Number(raw);
  }
}

function sameValue(left: DnsServerSettingValue, right: DnsServerSettingValue): boolean {
  return Array.isArray(left) && Array.isArray(right) ? joinMultiString(left) === joinMultiString(right) : left === right;
}

export function readServerSettings(parameters: DnsServerParameters, identity: DnsServerIdentity): DnsServerSettingEntry[] {
  return SERVER_SETTINGS.map(spec => ({
    property: spec.property, kind: spec.kind, brief: spec.brief, value: readValue(spec, parameters, identity),
  }));
}

export function writeServerSettings(
  parameters: DnsServerParameters, identity: DnsServerIdentity, changes: ReadonlyMap<string, DnsServerSettingValue>,
): string | null {
  const planned: Array<() => void> = [];
  for (const [property, value] of changes) {
    const spec = SERVER_SETTINGS.find(candidate => candidate.property.toLowerCase() === property.toLowerCase());
    if (spec === undefined || spec.registry === null) continue;
    if (sameValue(readValue(spec, parameters, identity), value)) continue;
    const registry = spec.registry;
    switch (spec.kind) {
      case 'flag':
        planned.push(() => parameters.writeSetting(registry, 'DWord', value === true ? 1 : 0));
        break;
      case 'count':
      case 'span': {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0) return 'The parameter is incorrect.';
        if (spec.mustRange !== undefined && (number < spec.mustRange[0] || number > spec.mustRange[1])) return 'The parameter is incorrect.';
        planned.push(() => parameters.writeSetting(registry, 'DWord', number));
        break;
      }
      case 'text':
        planned.push(() => parameters.writeSetting(registry, 'String', String(value ?? '')));
        break;
      case 'ports':
        planned.push(() => parameters.writeSetting(registry, 'MultiString', joinMultiString(value as readonly string[])));
        break;
      case 'sendPort': {
        const port = value === RANDOM_SEND_PORT ? 0 : Number(value);
        if (!Number.isInteger(port) || port < 0) return 'The parameter is incorrect.';
        planned.push(() => parameters.writeSetting(registry, 'DWord', port));
        break;
      }
    }
  }
  for (const write of planned) write();
  return null;
}
