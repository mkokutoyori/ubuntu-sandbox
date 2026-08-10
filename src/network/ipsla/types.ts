import type { IPAddress, MACAddress, EthernetFrame } from '../core/types';
import type { Port } from '../hardware/Port';

export const UDP_PORT_IPSLA_CONTROL = 1967;
export const UDP_PORT_ECHO = 7;

export type SlaOperationType =
  | 'icmp-echo'
  | 'icmp-jitter'
  | 'udp-echo'
  | 'udp-jitter'
  | 'tcp-connect'
  | 'http'
  | 'dns'
  | 'path-echo'
  | 'unknown';

export type SlaReturnCode =
  | 'ok'
  | 'overThreshold'
  | 'timeout'
  | 'notConnected'
  | 'dropped'
  | 'sequenceError'
  | 'verifyError'
  | 'applicationSpecific';

export const SENSE_OF_RETURN_CODE: Record<SlaReturnCode, number> = {
  ok: 1,
  overThreshold: 3,
  timeout: 4,
  notConnected: 6,
  dropped: 7,
  sequenceError: 8,
  verifyError: 9,
  applicationSpecific: 10,
};

export const RETURN_CODE_LABEL: Record<SlaReturnCode, string> = {
  ok: 'OK',
  overThreshold: 'Over threshold',
  timeout: 'Timeout',
  notConnected: 'Not connected',
  dropped: 'Dropped',
  sequenceError: 'Sequence error',
  verifyError: 'Verify error',
  applicationSpecific: 'Application specific error',
};

export function isResponding(code: SlaReturnCode): boolean {
  return code === 'ok' || code === 'overThreshold';
}

export type SlaOperationState = 'pending' | 'active' | 'inactive';

export type SlaCodec = 'g711alaw' | 'g711ulaw' | 'g729a';

export interface SlaSchedule {
  configured: boolean;
  lifeSeconds: number | 'forever';
  ageoutSeconds: number;
  recurring: boolean;
  startPending: boolean;
  startAfterSeconds: number | null;
  startAtSecondsOfDay: number | null;
  groupName: string | null;
}

export function defaultSchedule(): SlaSchedule {
  return {
    configured: false,
    lifeSeconds: 3600,
    ageoutSeconds: 0,
    recurring: false,
    startPending: false,
    startAfterSeconds: null,
    startAtSecondsOfDay: null,
    groupName: null,
  };
}

export interface SlaHttpConfig {
  url: string | null;
  mode: 'get' | 'raw';
  version: string;
  rawRequest: string[];
  nameServer: string | null;
  cache: boolean;
  proxy: string | null;
}

export interface SlaDnsConfig {
  name: string | null;
  nameServer: string | null;
}

export interface SlaOperationConfig {
  id: number;
  type: SlaOperationType;
  target: string | null;
  targetPort: number | null;
  sourceInterface: string | null;
  sourceIp: string | null;
  sourcePort: number | null;
  frequencySeconds: number;
  timeoutMs: number;
  thresholdMs: number;
  requestDataSize: number;
  tos: number;
  verifyData: boolean;
  tag: string | null;
  owner: string | null;
  numPackets: number;
  intervalMs: number;

  aggregateProbes: number;

  failPercent: number;
  codec: SlaCodec | null;
  advantageFactor: number;
  controlEnabled: boolean;
  maxHops: number;
  historyLivesKept: number;
  historyBucketsKept: number;
  historyFilter: 'none' | 'all' | 'overThreshold' | 'failures';
  distributionsKept: number;
  distributionIntervalMs: number;
  hoursOfStatisticsKept: number;
  precision: 'milliseconds' | 'microseconds';
  http: SlaHttpConfig;
  dns: SlaDnsConfig;
  schedule: SlaSchedule;
}

export const OPERATION_TYPE_DEFAULTS: Partial<Record<SlaOperationType, Partial<SlaOperationConfig>>> = {
  'icmp-echo': { requestDataSize: 28, timeoutMs: 5000 },
  'icmp-jitter': { requestDataSize: 28, numPackets: 10, intervalMs: 20, timeoutMs: 5000 },
  'udp-echo': { requestDataSize: 16, timeoutMs: 5000 },
  'udp-jitter': { requestDataSize: 32, numPackets: 10, intervalMs: 20, timeoutMs: 5000 },
  'tcp-connect': { requestDataSize: 0, timeoutMs: 5000 },
  'http': { requestDataSize: 0, timeoutMs: 60000 },
  'dns': { requestDataSize: 0, timeoutMs: 5000 },
  'path-echo': { requestDataSize: 28, timeoutMs: 5000, maxHops: 30 },
};

export interface SlaCodecProfile {
  ie: number;
  bpl: number;
  payloadBytes: number;
  numPackets: number;
  intervalMs: number;
}

export const CODEC_PROFILES: Record<SlaCodec, SlaCodecProfile> = {
  g711alaw: { ie: 0, bpl: 4.3, payloadBytes: 172, numPackets: 1000, intervalMs: 20 },
  g711ulaw: { ie: 0, bpl: 4.3, payloadBytes: 172, numPackets: 1000, intervalMs: 20 },
  g729a: { ie: 11, bpl: 19, payloadBytes: 32, numPackets: 1000, intervalMs: 20 },
};

export function createOperationConfig(id: number): SlaOperationConfig {
  return {
    id,
    type: 'unknown',
    target: null,
    targetPort: null,
    sourceInterface: null,
    sourceIp: null,
    sourcePort: null,
    frequencySeconds: 60,
    timeoutMs: 5000,
    thresholdMs: 5000,
    requestDataSize: 28,
    tos: 0,
    verifyData: false,
    tag: null,
    owner: null,
    numPackets: 10,
    intervalMs: 20,
    aggregateProbes: 1,
    failPercent: 100,
    codec: null,
    advantageFactor: 0,
    controlEnabled: true,
    maxHops: 30,
    historyLivesKept: 0,
    historyBucketsKept: 15,
    historyFilter: 'none',
    distributionsKept: 1,
    distributionIntervalMs: 20,
    hoursOfStatisticsKept: 2,
    precision: 'milliseconds',
    http: { url: null, mode: 'get', version: '1.0', rawRequest: [], nameServer: null, cache: true, proxy: null },
    dns: { name: null, nameServer: null },
    schedule: defaultSchedule(),
  };
}

export function applyTypeDefaults(cfg: SlaOperationConfig, type: SlaOperationType): void {
  const defaults = OPERATION_TYPE_DEFAULTS[type];
  if (!defaults) return;
  Object.assign(cfg, defaults);
}

export function applyCodecDefaults(cfg: SlaOperationConfig, codec: SlaCodec): void {
  const profile = CODEC_PROFILES[codec];
  cfg.codec = codec;
  cfg.requestDataSize = profile.payloadBytes;
  cfg.numPackets = profile.numPackets;
  cfg.intervalMs = profile.intervalMs;
}

export interface SlaHopResult {
  hop: number;
  address: string | null;
  rttMs: number | null;
  returnCode: SlaReturnCode;
}

export interface SlaOneWaySamples {
  sourceToDestination: number[];
  destinationToSource: number[];
}

export interface SlaJitterMeasurement {
  rtts: number[];
  sourceToDestination: number[];
  destinationToSource: number[];
  oneWayValid: boolean;
  packetLossSD: number;
  packetLossDS: number;
  packetMIA: number;
  packetOutOfSequence: number;
  packetLateArrival: number;
  packetsSent: number;
}

export interface SlaBatchMeasurement {
  sent: number;
  received: number;
  rtts: number[];
  overThreshold: number;
}

export interface SlaProbeOutcome {
  returnCode: SlaReturnCode;
  rttMs: number | null;
  diagText: string;
  respondingAddress: string | null;
  batch?: SlaBatchMeasurement;
  jitter?: SlaJitterMeasurement;
  hops?: SlaHopResult[];
  httpBreakdown?: { dnsRttMs: number; tcpConnectRttMs: number; transactionRttMs: number };
}

export interface IpSlaEgress {
  iface: string;
  sourceIp: IPAddress;
  sourceMac: MACAddress;
  destinationMac: MACAddress;
}

export interface IpSlaTcpProbeResult {
  connected: boolean;
  refused: boolean;
}

export interface IpSlaHost {
  readonly id: string;
  getHostname(): string;
  getPort(name: string): Port | undefined;
  resolveEgress(destination: IPAddress, sourceInterface: string | null, sourceIp: string | null): IpSlaEgress | null;
  /**
   * Put one ICMPv6 Echo Request on the wire and say which address it
   * left with. Separate from `resolveEgress`/`sendFrame` because the
   * IPv6 data plane owns its own neighbour resolution — routing an IPv6
   * probe through the IPv4 pair would mean a second, divergent copy of
   * that resolution. `null` means the probe never reached the wire.
   */
  sendIcmpv6Echo(request: {
    destination: string; identifier: number; sequence: number;
    dataSize: number; sourceInterface: string | null; sourceIp: string | null;
  }): { sourceIp: string } | null;
  sendFrame(iface: string, frame: EthernetFrame): void;
  sendUdp(destination: IPAddress, sourcePort: number, destinationPort: number, payload: unknown): boolean;
  connectTcp(ip: string, port: number, timeoutMs: number): Promise<IpSlaTcpProbeResult>;
  fetchHttp(ip: string, port: number, path: string, method: string): { ok: boolean; status: number; error?: string };
  tracePath(destination: IPAddress, maxHops: number, timeoutMs: number):
    Promise<Array<{ address: string | null; rttMs: number | null }>>;
  computeKeyDigest(chain: string, keyId: number, material: string): string | null;
  activeKeyId(chain: string): number | null;
  resolveHostname(name: string): string | null;
  isClockSynchronized(): boolean;
  epochMs(): number;
  log(severity: 'critical' | 'errors' | 'warnings' | 'notifications' | 'informational', mnemonic: string, text: string): void;
  sendTrap(oid: string, varBindings: Array<{ oid: string; kind: string; value: number | string }>): void;
}
