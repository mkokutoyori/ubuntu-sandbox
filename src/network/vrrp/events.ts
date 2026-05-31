import type { VrrpState } from './types';

export interface VrrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface VrrpPacketSentPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  state: VrrpState;
  priority: number;
}

export interface VrrpPacketReceivedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  fromIp: string;
  fromPriority: number;
}

export interface VrrpStateChangedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  oldState: VrrpState;
  newState: VrrpState;
  reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt';
}

export interface VrrpMasterChangedPayload extends VrrpDeviceRef {
  iface: string;
  vrid: number;
  masterIp: string | null;
  masterPriority: number;
}

export type VrrpDomainEvent =
  | { topic: 'vrrp.packet.sent'; payload: VrrpPacketSentPayload }
  | { topic: 'vrrp.packet.received'; payload: VrrpPacketReceivedPayload }
  | { topic: 'vrrp.state.changed'; payload: VrrpStateChangedPayload }
  | { topic: 'vrrp.master.changed'; payload: VrrpMasterChangedPayload };
