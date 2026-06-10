import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const ETHERTYPE_UDLD = 0x0111;
export const UDLD_MULTICAST_MAC = '01:00:0c:cc:cc:cc';
export const UDLD_LLC_OUI = '00:00:0c';
export const UDLD_SNAP_TYPE = 0x0111;

export type UdldOpcode =
  | 'probe' | 'echo' | 'flush';

export type UdldMode = 'disabled' | 'normal' | 'aggressive';

export type UdldPortStateName =
  | 'unknown'
  | 'bidirectional'
  | 'unidirectional'
  | 'tx-rx-loop'
  | 'neighbor-mismatch'
  | 'err-disable'
  | 'shutdown';

export interface UdldEchoEntry {
  deviceId: string;
  portId: string;
}

export interface UdldPacket extends NetworkPdu {
  type: 'udld';
  version: 1;
  opcode: UdldOpcode;
  senderDeviceId: string;
  senderPortId: string;
  senderHostname: string;
  helloIntervalSec: number;
  messageInterval: number;
  timeoutInterval: number;
  echo: UdldEchoEntry[];
}

export interface UdldNeighborEntry {
  localPort: string;
  remoteDeviceId: string;
  remotePortId: string;
  remoteHostname: string;
  lastHeardMs: number;
  helloIntervalSec: number;
  echo: UdldEchoEntry[];
}

export interface UdldPortRuntime {
  port: string;
  mode: UdldMode;
  state: UdldPortStateName;
  retries: number;
  lastTransitionMs: number;
}

export interface UdldConfig {
  enabled: boolean;
  globalMode: UdldMode;
  helloIntervalSec: number;
  messageTimeoutSec: number;
  aggressiveRetryLimit: number;
  ports: Map<string, UdldPortRuntime>;
}

export function createDefaultUdldConfig(): UdldConfig {
  return {
    enabled: true,
    globalMode: 'disabled',
    helloIntervalSec: 15,
    messageTimeoutSec: 45,
    aggressiveRetryLimit: 8,
    ports: new Map(),
  };
}

export function defaultPortRuntime(port: string, mode: UdldMode): UdldPortRuntime {
  return {
    port, mode, state: 'unknown', retries: 0,
    lastTransitionMs: Date.now(),
  };
}

export function neighborKey(localPort: string, remoteDeviceId: string, remotePortId: string): string {
  return `${localPort}|${remoteDeviceId}|${remotePortId}`;
}
