import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { createDefaultFhrpConfig, trackedPriority, type FhrpTrackEntry } from '../fhrp/types';
export const IP_PROTO_VRRP = 112;
export const VRRP_MULTICAST_IP = '224.0.0.18';
export const VRRP_MULTICAST_MAC = '01:00:5e:00:00:12';

export type VrrpState = 'init' | 'backup' | 'master';

export interface VrrpPacket extends NetworkPdu {
  type: 'vrrp';
  version: 2;
  vrid: number;
  priority: number;
  advertiseSec: number;
  vips: string[];
  senderIp: string;
}

export type VrrpTrackEntry = FhrpTrackEntry;

export interface VrrpGroupRuntime {
  iface: string;
  vrid: number;
  state: VrrpState;
  vip: string | null;
  priority: number;
  preempt: boolean;
  advertiseSec: number;
  masterIp: string | null;
  masterPriority: number;
  lastHeardMasterMs: number;
  lastTransitionMs: number;
  tracks: VrrpTrackEntry[];
}

export function effectivePriority(g: VrrpGroupRuntime): number {
  return trackedPriority(g.priority, g.tracks, 1, 254);
}

export interface VrrpConfig {
  enabled: boolean;
  groups: Map<string, VrrpGroupRuntime>;
}

export { makeFhrpKey as makeKey } from '../fhrp/types';

export function createDefaultVrrpConfig(): VrrpConfig {
  return createDefaultFhrpConfig<VrrpGroupRuntime>();
}

export function defaultGroupRuntime(iface: string, vrid: number): VrrpGroupRuntime {
  return {
    iface, vrid, state: 'init', vip: null, priority: 100, preempt: true,
    advertiseSec: 1,
    masterIp: null, masterPriority: 0,
    lastHeardMasterMs: 0, lastTransitionMs: Date.now(),
    tracks: [],
  };
}

export function vrrpVirtualMac(vrid: number): string {
  return `00:00:5e:00:01:${vrid.toString(16).padStart(2, '0')}`;
}

// Election comparison is shared across the FHRP family.
export { compareFhrpCandidates as compareCandidate } from '../fhrp/types';

export function masterDownIntervalMs(advertiseSec: number, priority: number): number {
  const skewSec = (256 - priority) / 256;
  return (3 * advertiseSec + skewSec) * 1000;
}
