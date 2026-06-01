import type { BfdState, BfdDiagnostic } from './types';

export interface BfdDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface BfdPacketSentPayload extends BfdDeviceRef {
  iface: string;
  neighborIp: string;
  state: BfdState;
  myDiscriminator: number;
  yourDiscriminator: number;
}

export interface BfdPacketReceivedPayload extends BfdDeviceRef {
  iface: string;
  neighborIp: string;
  remoteState: BfdState;
  myDiscriminator: number;
  yourDiscriminator: number;
}

export interface BfdSessionChangedPayload extends BfdDeviceRef {
  iface: string;
  neighborIp: string;
  oldState: BfdState;
  newState: BfdState;
  diagnostic: BfdDiagnostic;
  reason: 'config' | 'peer' | 'timeout' | 'admin' | 'link';
}

export type BfdDomainEvent =
  | { topic: 'bfd.packet.sent'; payload: BfdPacketSentPayload }
  | { topic: 'bfd.packet.received'; payload: BfdPacketReceivedPayload }
  | { topic: 'bfd.session.changed'; payload: BfdSessionChangedPayload };
