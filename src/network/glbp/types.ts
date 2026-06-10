import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_GLBP = 3222;
export const GLBP_MULTICAST_IP = '224.0.0.102';
export const GLBP_MULTICAST_MAC = '01:00:5e:00:00:66';

export type GlbpAvgState = 'disabled' | 'init' | 'standby' | 'active';
export type GlbpAvfState = 'disabled' | 'init' | 'listen' | 'active';
export type GlbpLoadBalancing = 'round-robin' | 'weighted' | 'host-dependent';

export interface GlbpForwarder {
  forwarderNumber: number;
  vmac: string;
  ownerIp: string | null;
  priority: number;
  weighting: number;
  state: GlbpAvfState;
  lastHeardMs: number;
}

export interface GlbpHelloTlv {
  type: 'hello';
  priority: number;
  weighting: number;
  vip: string;
  helloMs: number;
  holdMs: number;
}

export interface GlbpRequestTlv {
  type: 'request';
}

export interface GlbpAssignTlv {
  type: 'assign';
  forwarderNumber: number;
  vmac: string;
  ownerIp: string;
  priority: number;
  weighting: number;
}

export type GlbpTlv = GlbpHelloTlv | GlbpRequestTlv | GlbpAssignTlv;

export interface GlbpPacket extends NetworkPdu {
  type: 'glbp';
  version: 1;
  group: number;
  senderIp: string;
  tlvs: GlbpTlv[];
}

export interface GlbpGroupRuntime {
  iface: string;
  group: number;
  avgState: GlbpAvgState;
  vip: string | null;
  priority: number;
  weighting: number;
  preempt: boolean;
  loadBalancing: GlbpLoadBalancing;
  helloSec: number;
  holdSec: number;
  avgIp: string | null;
  avgPriority: number;
  lastHeardAvgMs: number;
  lastTransitionMs: number;
  forwarders: Map<number, GlbpForwarder>;
  rrCursor: number;
  hostMap: Map<string, number>;
}

export interface GlbpConfig {
  enabled: boolean;
  groups: Map<string, GlbpGroupRuntime>;
}

export function makeKey(iface: string, group: number): string {
  return `${iface}|${group}`;
}

export function createDefaultGlbpConfig(): GlbpConfig {
  return { enabled: true, groups: new Map() };
}

export function defaultGroupRuntime(iface: string, group: number): GlbpGroupRuntime {
  return {
    iface, group,
    avgState: 'init', vip: null,
    priority: 100, weighting: 100,
    preempt: false, loadBalancing: 'round-robin',
    helloSec: 3, holdSec: 10,
    avgIp: null, avgPriority: 0,
    lastHeardAvgMs: 0, lastTransitionMs: Date.now(),
    forwarders: new Map(),
    rrCursor: 0,
    hostMap: new Map(),
  };
}

export function glbpVirtualMac(group: number, forwarder: number): string {
  const g = group.toString(16).padStart(2, '0');
  const f = forwarder.toString(16).padStart(2, '0');
  return `00:07:b4:00:${g}:${f}`;
}

// Election comparison is shared across the FHRP family.
export { compareFhrpCandidates as compareCandidate } from '../fhrp/types';
