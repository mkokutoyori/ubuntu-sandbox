import type { EapolPacketType, EapCode, Dot1xPortState, Dot1xPortMode } from './types';

export interface Dot1xDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface Dot1xPacketSentPayload extends Dot1xDeviceRef {
  port: string;
  packetType: EapolPacketType;
  eapCode?: EapCode;
}

export interface Dot1xPacketReceivedPayload extends Dot1xDeviceRef {
  port: string;
  packetType: EapolPacketType;
  supplicantMac: string;
  identity: string | null;
}

export interface Dot1xPortStateChangedPayload extends Dot1xDeviceRef {
  port: string;
  oldState: Dot1xPortState;
  newState: Dot1xPortState;
  mode: Dot1xPortMode;
  reason: 'config' | 'eapol-start' | 'eap-response' | 'auth-success' | 'auth-failure' | 'eapol-logoff' | 'hold-expired' | 'link';
}

export interface Dot1xAuthOutcomePayload extends Dot1xDeviceRef {
  port: string;
  identity: string;
  accepted: boolean;
  reason: 'local-accept' | 'local-reject-unknown-user' | 'local-reject-bad-password' | 'radius-accept' | 'radius-reject';
}

export type Dot1xDomainEvent =
  | { topic: 'dot1x.packet.sent'; payload: Dot1xPacketSentPayload }
  | { topic: 'dot1x.packet.received'; payload: Dot1xPacketReceivedPayload }
  | { topic: 'dot1x.port.state.changed'; payload: Dot1xPortStateChangedPayload }
  | { topic: 'dot1x.auth.outcome'; payload: Dot1xAuthOutcomePayload };
