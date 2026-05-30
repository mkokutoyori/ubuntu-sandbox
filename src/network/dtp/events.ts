import type { DtpAdminMode, DtpOperationalMode } from './types';

export interface DtpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface DtpFrameSentPayload extends DtpDeviceRef {
  port: string;
  adminMode: DtpAdminMode;
  operationalMode: DtpOperationalMode;
}

export interface DtpFrameReceivedPayload extends DtpDeviceRef {
  port: string;
  peerMac: string;
  peerAdminMode: DtpAdminMode;
}

export interface DtpModeChangedPayload extends DtpDeviceRef {
  port: string;
  adminMode: DtpAdminMode;
  oldOperationalMode: DtpOperationalMode;
  newOperationalMode: DtpOperationalMode;
  reason: 'admin-change' | 'peer-update' | 'peer-loss' | 'link-down';
}

export type DtpDomainEvent =
  | { topic: 'dtp.frame.sent'; payload: DtpFrameSentPayload }
  | { topic: 'dtp.frame.received'; payload: DtpFrameReceivedPayload }
  | { topic: 'dtp.mode.changed'; payload: DtpModeChangedPayload };
