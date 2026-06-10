import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const ETHERTYPE_LACP = 0x8809;
export const LACP_SLOW_MAC = '01:80:c2:00:00:02';

export type LacpAdminMode = 'on' | 'active' | 'passive';
export type LacpPortState =
  | 'standalone'
  | 'sync'
  | 'collecting'
  | 'distributing'
  | 'bundled';

export interface LacpActorInfo {
  systemPriority: number;
  systemId: string;
  key: number;
  portPriority: number;
  portNumber: number;
  state: number;
}

export interface LacpFrame extends NetworkPdu {
  type: 'lacp';
  subtype: 0x01;
  version: 0x01;
  actor: LacpActorInfo;
  partner: LacpActorInfo;
  collectorMaxDelay: number;
}

export interface LacpPortInfo {
  portName: string;
  groupId: number;
  mode: LacpAdminMode;
  state: LacpPortState;
  partner: LacpActorInfo | null;
  selected: boolean;
  bundled: boolean;
  lastRxMs: number;
}

export interface LacpConfig {
  enabled: boolean;
  systemPriority: number;
  systemId: string;
  fastRate: boolean;
  ports: Map<string, LacpPortInfo>;
  groups: Map<number, { name: string; loadBalance: string }>;
}

export function createDefaultLacpConfig(systemId: string): LacpConfig {
  return {
    enabled: true,
    systemPriority: 32768,
    systemId: systemId.toLowerCase(),
    fastRate: false,
    ports: new Map(),
    groups: new Map(),
  };
}

export const LACP_FLAG_ACTIVITY = 0x01;
export const LACP_FLAG_TIMEOUT = 0x02;
export const LACP_FLAG_AGGREGATION = 0x04;
export const LACP_FLAG_SYNC = 0x08;
export const LACP_FLAG_COLLECTING = 0x10;
export const LACP_FLAG_DISTRIBUTING = 0x20;
export const LACP_FLAG_DEFAULTED = 0x40;
export const LACP_FLAG_EXPIRED = 0x80;

export function buildActorState(mode: LacpAdminMode, port: LacpPortInfo): number {
  let f = 0;
  if (mode === 'active') f |= LACP_FLAG_ACTIVITY;
  f |= LACP_FLAG_AGGREGATION;
  if (port.selected) f |= LACP_FLAG_SYNC;
  if (port.state === 'collecting' || port.state === 'distributing' || port.state === 'bundled') {
    f |= LACP_FLAG_COLLECTING;
  }
  if (port.state === 'distributing' || port.state === 'bundled') {
    f |= LACP_FLAG_DISTRIBUTING;
  }
  return f;
}

export function compareSystemId(a: { priority: number; id: string }, b: { priority: number; id: string }): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
}
