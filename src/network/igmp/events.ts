import type { IgmpMessageType, IgmpInterfaceState } from './types';

export interface IgmpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface IgmpPacketSentPayload extends IgmpDeviceRef {
  iface: string;
  messageType: IgmpMessageType;
  groupAddress: string;
  destinationIp: string;
}

export interface IgmpPacketReceivedPayload extends IgmpDeviceRef {
  iface: string;
  messageType: IgmpMessageType;
  groupAddress: string;
  fromIp: string;
}

export interface IgmpGroupJoinedPayload extends IgmpDeviceRef {
  iface: string;
  groupAddress: string;
  reporterIp: string;
}

export interface IgmpGroupLeftPayload extends IgmpDeviceRef {
  iface: string;
  groupAddress: string;
  reason: 'leave' | 'timeout';
}

export interface IgmpQuerierChangedPayload extends IgmpDeviceRef {
  iface: string;
  oldState: IgmpInterfaceState;
  newState: IgmpInterfaceState;
  querierIp: string | null;
}

export type IgmpDomainEvent =
  | { topic: 'igmp.packet.sent'; payload: IgmpPacketSentPayload }
  | { topic: 'igmp.packet.received'; payload: IgmpPacketReceivedPayload }
  | { topic: 'igmp.group.joined'; payload: IgmpGroupJoinedPayload }
  | { topic: 'igmp.group.left'; payload: IgmpGroupLeftPayload }
  | { topic: 'igmp.querier.changed'; payload: IgmpQuerierChangedPayload };
