import type { LacpAdminMode, LacpPortState } from './types';

export interface LacpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface LacpFrameSentPayload extends LacpDeviceRef {
  port: string;
  groupId: number;
  mode: LacpAdminMode;
}

export interface LacpFrameReceivedPayload extends LacpDeviceRef {
  port: string;
  partnerSystemId: string;
  partnerKey: number;
}

export interface LacpPortStateChangedPayload extends LacpDeviceRef {
  port: string;
  groupId: number;
  oldState: LacpPortState;
  newState: LacpPortState;
}

export interface LacpPortBundledPayload extends LacpDeviceRef {
  port: string;
  groupId: number;
  partnerSystemId: string;
}

export interface LacpPortUnbundledPayload extends LacpDeviceRef {
  port: string;
  groupId: number;
  cause: 'link-down' | 'partner-loss' | 'admin-change';
}

export type LacpDomainEvent =
  | { topic: 'lacp.frame.sent'; payload: LacpFrameSentPayload }
  | { topic: 'lacp.frame.received'; payload: LacpFrameReceivedPayload }
  | { topic: 'lacp.port.state-changed'; payload: LacpPortStateChangedPayload }
  | { topic: 'lacp.port.bundled'; payload: LacpPortBundledPayload }
  | { topic: 'lacp.port.unbundled'; payload: LacpPortUnbundledPayload };
