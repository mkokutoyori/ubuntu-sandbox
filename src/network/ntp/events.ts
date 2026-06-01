import type { NtpMode } from './types';

export interface NtpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface NtpPacketSentPayload extends NtpDeviceRef {
  serverIp: string;
  mode: NtpMode;
}

export interface NtpPacketReceivedPayload extends NtpDeviceRef {
  fromIp: string;
  mode: NtpMode;
  stratum: number;
}

export interface NtpSyncedPayload extends NtpDeviceRef {
  serverIp: string;
  offsetMs: number;
  delayMs: number;
  newStratum: number;
}

export interface NtpUnsyncedPayload extends NtpDeviceRef {
  reason: 'reach-zero' | 'admin-disabled' | 'unreachable';
}

export interface NtpServerRespondedPayload extends NtpDeviceRef {
  clientIp: string;
  stratum: number;
}

export type NtpDomainEvent =
  | { topic: 'ntp.packet.sent'; payload: NtpPacketSentPayload }
  | { topic: 'ntp.packet.received'; payload: NtpPacketReceivedPayload }
  | { topic: 'ntp.synced'; payload: NtpSyncedPayload }
  | { topic: 'ntp.unsynced'; payload: NtpUnsyncedPayload }
  | { topic: 'ntp.server.responded'; payload: NtpServerRespondedPayload };
