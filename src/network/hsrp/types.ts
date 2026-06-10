export const UDP_PORT_HSRP = 1985;
export const HSRP_MULTICAST_V1 = '224.0.0.2';
export const HSRP_MULTICAST_V2 = '224.0.0.102';

export type HsrpOpcode = 'hello' | 'coup' | 'resign';
export type HsrpState =
  | 'init' | 'listen' | 'learn' | 'speak' | 'standby' | 'active';

export interface HsrpPacket {
  type: 'hsrp';
  version: 1 | 2;
  opcode: HsrpOpcode;
  state: HsrpState;
  helloSec: number;
  holdSec: number;
  priority: number;
  group: number;
  authText: string;
  vip: string;
  senderIp: string;
}

export interface HsrpTrackEntry {
  target: string;
  decrement: number;
  down: boolean;
}

export interface HsrpGroupRuntime {
  iface: string;
  group: number;
  state: HsrpState;
  vip: string | null;
  priority: number;
  preempt: boolean;
  helloSec: number;
  holdSec: number;
  version: 1 | 2;
  authText: string;
  activeRouterIp: string | null;
  activeRouterPriority: number;
  standbyRouterIp: string | null;
  standbyRouterPriority: number;
  lastHeardActiveMs: number;
  lastHeardStandbyMs: number;
  lastTransitionMs: number;
  tracks: HsrpTrackEntry[];
}

export interface HsrpConfig {
  enabled: boolean;
  groups: Map<string, HsrpGroupRuntime>;
}

export function makeKey(iface: string, group: number): string {
  return `${iface}|${group}`;
}

export function createDefaultHsrpConfig(): HsrpConfig {
  return { enabled: true, groups: new Map() };
}

export function defaultGroupRuntime(iface: string, group: number, version: 1 | 2 = 1): HsrpGroupRuntime {
  return {
    iface, group, state: 'init', vip: null, priority: 100, preempt: false,
    helloSec: 3, holdSec: 10, version, authText: 'cisco',
    activeRouterIp: null, activeRouterPriority: 0,
    standbyRouterIp: null, standbyRouterPriority: 0,
    lastHeardActiveMs: 0, lastHeardStandbyMs: 0, lastTransitionMs: Date.now(),
    tracks: [],
  };
}

export function effectivePriority(g: HsrpGroupRuntime): number {
  let p = g.priority;
  for (const t of g.tracks) if (t.down) p -= t.decrement;
  if (p < 0) p = 0;
  if (p > 255) p = 255;
  return p;
}

export function hsrpVirtualMac(group: number, version: 1 | 2): string {
  if (version === 2) {
    return `0000.0c9f.f${group.toString(16).padStart(3, '0')}`;
  }
  return `0000.0c07.ac${group.toString(16).padStart(2, '0')}`;
}

// Election comparison is shared across the FHRP family.
export { compareFhrpCandidates as compareSpeaker } from '../fhrp/types';
