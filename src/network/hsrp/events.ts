import type { HsrpOpcode, HsrpState } from './types';

export interface HsrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface HsrpPacketSentPayload extends HsrpDeviceRef {
  iface: string;
  group: number;
  opcode: HsrpOpcode;
  state: HsrpState;
  priority: number;
}

export interface HsrpPacketReceivedPayload extends HsrpDeviceRef {
  iface: string;
  group: number;
  fromIp: string;
  fromPriority: number;
  fromState: HsrpState;
}

export interface HsrpStateChangedPayload extends HsrpDeviceRef {
  iface: string;
  group: number;
  oldState: HsrpState;
  newState: HsrpState;
  reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt';
}

export interface HsrpActiveChangedPayload extends HsrpDeviceRef {
  iface: string;
  group: number;
  activeIp: string | null;
  activePriority: number;
}

export type HsrpDomainEvent =
  | { topic: 'hsrp.packet.sent'; payload: HsrpPacketSentPayload }
  | { topic: 'hsrp.packet.received'; payload: HsrpPacketReceivedPayload }
  | { topic: 'hsrp.state.changed'; payload: HsrpStateChangedPayload }
  | { topic: 'hsrp.active.changed'; payload: HsrpActiveChangedPayload };
