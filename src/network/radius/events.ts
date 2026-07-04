import type { RadiusCode } from './types';

export interface RadiusDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface RadiusPacketSentPayload extends RadiusDeviceRef {
  destinationIp: string;
  code: RadiusCode;
  identifier: number;
  username: string | null;
}

export interface RadiusPacketReceivedPayload extends RadiusDeviceRef {
  fromIp: string;
  code: RadiusCode;
  identifier: number;
}

export interface RadiusAuthCompletedPayload extends RadiusDeviceRef {
  serverIp: string;
  username: string;
  accepted: boolean;
  identifier: number;
  reason: string | null;
}

export interface RadiusAuthRejectedByServerPayload extends RadiusDeviceRef {
  fromIp: string;
  username: string;
  reason: 'unknown-user' | 'bad-password' | 'bad-secret' | 'client-not-authorized';
}

export interface RadiusAccountingRecordPayload extends RadiusDeviceRef {
  serverIp: string;
  sessionId: string;
  username: string;
  status: 'start' | 'interim-update' | 'stop';
  sessionTimeSec: number;
  inputOctets: number;
  outputOctets: number;
  terminateCause: string | null;
}

export interface RadiusServerHealthPayload extends RadiusDeviceRef {
  serverIp: string;
}

export interface RadiusCoaReceivedPayload extends RadiusDeviceRef {
  fromIp: string;
  code: 'disconnect-request' | 'coa-request';
  username: string | null;
  accepted: boolean;
  errorCause: string | null;
}

export interface RadiusCoaCompletedPayload extends RadiusDeviceRef {
  nasIp: string;
  code: 'disconnect-request' | 'coa-request';
  result: 'ack' | 'nak' | 'timeout';
  errorCause: string | null;
}

/** RFC 6613 — RADIUS/TCP. Fired by both `RadiusTcpClient` (NAS) and `RadiusTcpServer` on each PAP round. */
export interface RadiusTcpCompletedPayload extends RadiusDeviceRef {
  serverIp: string;
  username: string;
  result: 'accept' | 'reject' | 'timeout';
}

export type RadiusDomainEvent =
  | { topic: 'radius.packet.sent'; payload: RadiusPacketSentPayload }
  | { topic: 'radius.packet.received'; payload: RadiusPacketReceivedPayload }
  | { topic: 'radius.auth.completed'; payload: RadiusAuthCompletedPayload }
  | { topic: 'radius.auth.rejected'; payload: RadiusAuthRejectedByServerPayload }
  | { topic: 'radius.accounting.record'; payload: RadiusAccountingRecordPayload }
  | { topic: 'radius.server.dead'; payload: RadiusServerHealthPayload }
  | { topic: 'radius.server.alive'; payload: RadiusServerHealthPayload }
  | { topic: 'radius.coa.received'; payload: RadiusCoaReceivedPayload }
  | { topic: 'radius.coa.completed'; payload: RadiusCoaCompletedPayload }
  | { topic: 'radius.tcp.completed'; payload: RadiusTcpCompletedPayload };
