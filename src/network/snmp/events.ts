import type { SnmpPduType, SnmpErrorStatus } from './types';

export interface SnmpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface SnmpPacketSentPayload extends SnmpDeviceRef {
  destinationIp: string;
  pduType: SnmpPduType;
  requestId: number;
  community: string;
}

export interface SnmpPacketReceivedPayload extends SnmpDeviceRef {
  fromIp: string;
  pduType: SnmpPduType;
  requestId: number;
  community: string;
}

export interface SnmpRequestServedPayload extends SnmpDeviceRef {
  fromIp: string;
  pduType: SnmpPduType;
  requestId: number;
  errorStatus: SnmpErrorStatus;
  oidCount: number;
}

export interface SnmpAuthRejectedPayload extends SnmpDeviceRef {
  fromIp: string;
  community: string;
  reason: 'unknown-community' | 'read-only-access';
}

export interface SnmpTrapSentPayload extends SnmpDeviceRef {
  destinationIp: string;
  community: string;
  trapOid: string;
}

export type SnmpDomainEvent =
  | { topic: 'snmp.packet.sent'; payload: SnmpPacketSentPayload }
  | { topic: 'snmp.packet.received'; payload: SnmpPacketReceivedPayload }
  | { topic: 'snmp.request.served'; payload: SnmpRequestServedPayload }
  | { topic: 'snmp.auth.rejected'; payload: SnmpAuthRejectedPayload }
  | { topic: 'snmp.trap.sent'; payload: SnmpTrapSentPayload };
