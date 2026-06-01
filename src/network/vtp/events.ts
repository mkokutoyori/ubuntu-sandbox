import type { VtpMode, VtpVersion } from './types';

export interface VtpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface VtpFrameSentPayload extends VtpDeviceRef {
  port: string;
  messageType: string;
  domain: string;
  revision: number;
}

export interface VtpFrameReceivedPayload extends VtpDeviceRef {
  port: string;
  fromDomain: string;
  fromRevision: number;
  accepted: boolean;
  rejectReason?: string;
}

export interface VtpDbSyncedPayload extends VtpDeviceRef {
  port: string;
  oldRevision: number;
  newRevision: number;
  vlansAdded: number[];
  vlansRemoved: number[];
}

export interface VtpModeChangedPayload extends VtpDeviceRef {
  oldMode: VtpMode;
  newMode: VtpMode;
}

export interface VtpDomainChangedPayload extends VtpDeviceRef {
  oldDomain: string;
  newDomain: string;
  version: VtpVersion;
}

export type VtpDomainEvent =
  | { topic: 'vtp.frame.sent'; payload: VtpFrameSentPayload }
  | { topic: 'vtp.frame.received'; payload: VtpFrameReceivedPayload }
  | { topic: 'vtp.db.synced'; payload: VtpDbSyncedPayload }
  | { topic: 'vtp.mode.changed'; payload: VtpModeChangedPayload }
  | { topic: 'vtp.domain.changed'; payload: VtpDomainChangedPayload };
