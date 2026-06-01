import type { GlbpAvgState, GlbpAvfState } from './types';

export interface GlbpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface GlbpPacketSentPayload extends GlbpDeviceRef {
  iface: string;
  group: number;
  avgState: GlbpAvgState;
  priority: number;
}

export interface GlbpPacketReceivedPayload extends GlbpDeviceRef {
  iface: string;
  group: number;
  fromIp: string;
  fromPriority: number;
}

export interface GlbpAvgChangedPayload extends GlbpDeviceRef {
  iface: string;
  group: number;
  oldState: GlbpAvgState;
  newState: GlbpAvgState;
  reason: 'config' | 'peer' | 'timeout' | 'priority' | 'preempt';
}

export interface GlbpAvfAssignedPayload extends GlbpDeviceRef {
  iface: string;
  group: number;
  forwarderNumber: number;
  vmac: string;
  ownerIp: string;
}

export interface GlbpAvfStateChangedPayload extends GlbpDeviceRef {
  iface: string;
  group: number;
  forwarderNumber: number;
  oldState: GlbpAvfState;
  newState: GlbpAvfState;
}

export type GlbpDomainEvent =
  | { topic: 'glbp.packet.sent'; payload: GlbpPacketSentPayload }
  | { topic: 'glbp.packet.received'; payload: GlbpPacketReceivedPayload }
  | { topic: 'glbp.avg.changed'; payload: GlbpAvgChangedPayload }
  | { topic: 'glbp.avf.assigned'; payload: GlbpAvfAssignedPayload }
  | { topic: 'glbp.avf.state.changed'; payload: GlbpAvfStateChangedPayload };
