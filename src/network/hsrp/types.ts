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
  };
}

export function hsrpVirtualMac(group: number, version: 1 | 2): string {
  if (version === 2) {
    return `0000.0c9f.f${group.toString(16).padStart(3, '0')}`;
  }
  return `0000.0c07.ac${group.toString(16).padStart(2, '0')}`;
}

export function compareSpeaker(
  a: { priority: number; ip: string },
  b: { priority: number; ip: string },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ai = a.ip.split('.').map(Number);
  const bi = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return bi[i] - ai[i];
  return 0;
}
