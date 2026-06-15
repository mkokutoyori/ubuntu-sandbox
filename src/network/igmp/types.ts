import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const IP_PROTO_IGMP = 2;
export const IGMP_ALL_SYSTEMS = '224.0.0.1';
export const IGMP_ALL_ROUTERS = '224.0.0.2';

export type IgmpMessageType =
  | 'membership-query'
  | 'v2-membership-report'
  | 'v1-membership-report'
  | 'leave-group';

export type IgmpQueryType = 'general' | 'group-specific';

export interface IgmpPacket extends NetworkPdu {
  type: 'igmp';
  version: 2;
  messageType: IgmpMessageType;
  maxRespTimeDs: number;
  groupAddress: string;
  checksum: number;
}

export type IgmpInterfaceState = 'querier' | 'non-querier' | 'startup';

export interface IgmpGroupRecord {
  groupAddress: string;
  iface: string;
  reporters: Set<string>;
  lastReporterIp: string | null;
  lastReportMs: number;
  v1Compat: boolean;
}

export interface IgmpInterfaceRuntime {
  iface: string;
  enabled: boolean;
  version: 1 | 2;
  state: IgmpInterfaceState;
  querierIp: string | null;
  lastQuerierMs: number;
  startupQueriesSent: number;
  queryIntervalSec: number;
  queryResponseIntervalDs: number;
  lastMemberQueryIntervalDs: number;
  lastMemberQueryCount: number;
  startupQueryCount: number;
  otherQuerierPresentSec: number;
  robustness: number;
}

export interface IgmpConfig {
  enabled: boolean;
  interfaces: Map<string, IgmpInterfaceRuntime>;
  groups: Map<string, IgmpGroupRecord>;
}

export function makeGroupKey(iface: string, group: string): string {
  return `${iface}|${group}`;
}

export function createDefaultIgmpConfig(): IgmpConfig {
  return { enabled: true, interfaces: new Map(), groups: new Map() };
}

export function defaultIfaceRuntime(iface: string): IgmpInterfaceRuntime {
  return {
    iface, enabled: false, version: 2,
    state: 'startup',
    querierIp: null, lastQuerierMs: 0,
    startupQueriesSent: 0,
    queryIntervalSec: 125,
    queryResponseIntervalDs: 100,
    lastMemberQueryIntervalDs: 10,
    lastMemberQueryCount: 2,
    startupQueryCount: 2,
    otherQuerierPresentSec: 255,
    robustness: 2,
  };
}

export function groupMembershipIntervalSec(rt: IgmpInterfaceRuntime): number {
  return rt.robustness * rt.queryIntervalSec + Math.ceil(rt.queryResponseIntervalDs / 10);
}

// RFC 1112 address arithmetic lives in core/ip.ts (canonical home);
// re-exported here so IGMP callers keep their historical import path.
export { ipv4MulticastToMac, isMulticastIpv4 } from '../core/ip';

export function isReservedMulticast(ip: string): boolean {
  return ip.startsWith('224.0.0.');
}

export function compareQuerier(a: string, b: string): number {
  const ai = a.split('.').map(Number);
  const bi = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return ai[i] - bi[i];
  return 0;
}
