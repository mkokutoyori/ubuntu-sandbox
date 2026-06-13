export const ETHERTYPE_STP = 0x4242;
export const STP_BRIDGE_MAC = '01:80:c2:00:00:00';

export type StpBpduType = 'config' | 'tcn';
/**
 * Port roles per IEEE 802.1D-2004 §17.7. Classic 802.1D only names
 * root/designated/blocked, but the rapid (802.1w) role taxonomy
 * distinguishes the two kinds of blocked port — and Cisco/Huawei show
 * commands report them separately even in legacy mode:
 *  - `alternate`: blocked because a *different* bridge offers a better
 *    path to the root (an alternate path to the root port);
 *  - `backup`: blocked because *our own* bridge offers a superior BPDU
 *    on the same shared segment (backs up a local designated port).
 * Both are in the Discarding/Blocking forwarding state.
 */
export type StpPortRole =
  | 'root' | 'designated' | 'alternate' | 'backup' | 'disabled';

export interface BridgeId {
  priority: number;
  mac: string;
}

export type StpProtocolMode = 'stp' | 'rstp';

export interface StpBpdu {
  type: 'stp';
  bpduType: StpBpduType;
  protocolId: 0x0000;
  version: 0 | 2;
  flags: number;
  proposal?: boolean;
  agreement?: boolean;
  rootBridge: BridgeId;
  rootPathCost: number;
  senderBridge: BridgeId;
  portId: number;
  messageAgeSec: number;
  maxAgeSec: number;
  helloSec: number;
  forwardDelaySec: number;
  topologyChange: boolean;
  topologyChangeAck: boolean;
}

export interface StpPortGuards {
  portFast: boolean;
  bpduGuard: boolean;
  rootGuard: boolean;
}

export function defaultPortGuards(): StpPortGuards {
  return { portFast: false, bpduGuard: false, rootGuard: false };
}

export interface StpConfig {
  enabled: boolean;
  mode: StpProtocolMode;
  bridgePriority: number;
  helloSec: number;
  maxAgeSec: number;
  forwardDelaySec: number;
  baseMac: string;
  bpduGuardGlobal: boolean;
}

export interface StpPortInfo {
  role: StpPortRole;
  cost: number;
  designatedRoot: BridgeId;
  designatedBridge: BridgeId;
  designatedCost: number;
  designatedPort: number;
  ageMs: number;
}

export function createDefaultStpConfig(baseMac: string): StpConfig {
  return {
    enabled: true,
    mode: 'stp',
    bridgePriority: 32768,
    helloSec: 2,
    maxAgeSec: 20,
    forwardDelaySec: 15,
    baseMac: baseMac.toLowerCase(),
    bpduGuardGlobal: false,
  };
}

export function defaultPathCost(speedKbps: number): number {
  if (speedKbps >= 10_000_000) return 2;
  if (speedKbps >= 1_000_000) return 4;
  if (speedKbps >= 100_000) return 19;
  if (speedKbps >= 10_000) return 100;
  return 200;
}

export function compareBridge(a: BridgeId, b: BridgeId): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const am = a.mac.toLowerCase();
  const bm = b.mac.toLowerCase();
  return am < bm ? -1 : am > bm ? 1 : 0;
}

export function bridgeEquals(a: BridgeId, b: BridgeId): boolean {
  return a.priority === b.priority
    && a.mac.toLowerCase() === b.mac.toLowerCase();
}

export function bridgeToString(b: BridgeId): string {
  return `${b.priority}/${b.mac}`;
}
