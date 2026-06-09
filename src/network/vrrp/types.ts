export const IP_PROTO_VRRP = 112;
export const VRRP_MULTICAST_IP = '224.0.0.18';
export const VRRP_MULTICAST_MAC = '01:00:5e:00:00:12';

export type VrrpState = 'init' | 'backup' | 'master';

export interface VrrpPacket {
  type: 'vrrp';
  version: 2;
  vrid: number;
  priority: number;
  advertiseSec: number;
  vips: string[];
  senderIp: string;
}

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
}

export interface VrrpConfig {
  enabled: boolean;
  groups: Map<string, VrrpGroupRuntime>;
}

export function makeKey(iface: string, vrid: number): string {
  return `${iface}|${vrid}`;
}

export function createDefaultVrrpConfig(): VrrpConfig {
  return { enabled: true, groups: new Map() };
}

export function defaultGroupRuntime(iface: string, vrid: number): VrrpGroupRuntime {
  return {
    iface, vrid, state: 'init', vip: null, priority: 100, preempt: true,
    advertiseSec: 1,
    masterIp: null, masterPriority: 0,
    lastHeardMasterMs: 0, lastTransitionMs: Date.now(),
  };
}

export function vrrpVirtualMac(vrid: number): string {
  return `00:00:5e:00:01:${vrid.toString(16).padStart(2, '0')}`;
}

export function compareCandidate(
  a: { priority: number; ip: string },
  b: { priority: number; ip: string },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ai = a.ip.split('.').map(Number);
  const bi = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return bi[i] - ai[i];
  return 0;
}

export function masterDownIntervalMs(advertiseSec: number, priority: number): number {
  const skewSec = (256 - priority) / 256;
  return (3 * advertiseSec + skewSec) * 1000;
}
