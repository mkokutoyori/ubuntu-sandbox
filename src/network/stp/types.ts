export const ETHERTYPE_STP = 0x4242;
export const STP_BRIDGE_MAC = '01:80:c2:00:00:00';

export type StpBpduType = 'config' | 'tcn';
export type StpPortRole = 'root' | 'designated' | 'alternate' | 'disabled';

export interface BridgeId {
  priority: number;
  mac: string;
}

export interface StpBpdu {
  type: 'stp';
  bpduType: StpBpduType;
  protocolId: 0x0000;
  version: 0;
  flags: number;
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
  return a.mac.localeCompare(b.mac);
}

export function bridgeEquals(a: BridgeId, b: BridgeId): boolean {
  return a.priority === b.priority && a.mac === b.mac;
}

export function bridgeToString(b: BridgeId): string {
  return `${b.priority}/${b.mac}`;
}
