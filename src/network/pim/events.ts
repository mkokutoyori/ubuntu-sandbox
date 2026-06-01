import type { PimMessageType } from './types';

export interface PimDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface PimPacketSentPayload extends PimDeviceRef {
  iface: string;
  messageType: PimMessageType;
  destinationIp: string;
}

export interface PimPacketReceivedPayload extends PimDeviceRef {
  iface: string;
  messageType: PimMessageType;
  fromIp: string;
}

export interface PimNeighborAddedPayload extends PimDeviceRef {
  iface: string;
  neighborIp: string;
  drPriority: number;
  generationId: number;
}

export interface PimNeighborLostPayload extends PimDeviceRef {
  iface: string;
  neighborIp: string;
  reason: 'timeout' | 'link' | 'gen-id-changed' | 'config';
}

export interface PimDrChangedPayload extends PimDeviceRef {
  iface: string;
  oldDrIp: string | null;
  newDrIp: string;
}

export type PimDomainEvent =
  | { topic: 'pim.packet.sent'; payload: PimPacketSentPayload }
  | { topic: 'pim.packet.received'; payload: PimPacketReceivedPayload }
  | { topic: 'pim.neighbor.added'; payload: PimNeighborAddedPayload }
  | { topic: 'pim.neighbor.lost'; payload: PimNeighborLostPayload }
  | { topic: 'pim.dr.changed'; payload: PimDrChangedPayload };
