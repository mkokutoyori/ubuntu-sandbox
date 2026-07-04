import type { NetworkPdu } from '@/network/core/NetworkPdu';
// EAP itself (RFC 3748) lives under radius/ — 802.1X is only a transport for
// it, and the RADIUS server terminates the same packets via EAP-Message.
export { EAP_CODE, EAP_TYPE, type EapCode, type EapType, type EapPacket } from '@/network/radius/eap';
import type { EapPacket } from '@/network/radius/eap';

export const ETHERTYPE_EAPOL = 0x888e;
export const EAPOL_PAE_GROUP_MAC = '01:80:c2:00:00:03';

export type EapolPacketType =
  | 'eap-packet'
  | 'eapol-start'
  | 'eapol-logoff'
  | 'eapol-key'
  | 'eapol-encapsulated-asf-alert';

export const EAPOL_PACKET_TYPE: Record<EapolPacketType, number> = {
  'eap-packet': 0,
  'eapol-start': 1,
  'eapol-logoff': 2,
  'eapol-key': 3,
  'eapol-encapsulated-asf-alert': 4,
};

export interface EapolPacket extends NetworkPdu {
  type: 'eapol';
  version: number;
  packetType: EapolPacketType;
  eap?: EapPacket;
}

export type Dot1xPortMode =
  | 'disabled'
  | 'force-authorized'
  | 'auto'
  | 'force-unauthorized';

export type Dot1xPortState =
  | 'unauthorized'
  | 'authenticating'
  | 'authorized'
  | 'force-authorized'
  | 'force-unauthorized'
  | 'held';

export interface Dot1xLocalUser {
  username: string;
  password: string;
}

export interface Dot1xPortRuntime {
  port: string;
  mode: Dot1xPortMode;
  state: Dot1xPortState;
  identity: string | null;
  pendingEapId: number | null;
  lastSupplicantMac: string | null;
  /** RADIUS State (RFC 2865 §4.4) to echo on the next EAP relay round — set while an EAP-MD5 exchange is in flight. */
  radiusState: string | null;
  reauthCount: number;
  lastTransitionMs: number;
  maxReauthReq: number;
  holdMs: number;
  holdUntilMs: number;
}

export interface Dot1xConfig {
  enabled: boolean;
  ports: Map<string, Dot1xPortRuntime>;
  localUsers: Map<string, Dot1xLocalUser>;
  defaultMaxReauthReq: number;
  defaultHoldMs: number;
}

export function createDefaultDot1xConfig(): Dot1xConfig {
  return {
    enabled: false,
    ports: new Map(),
    localUsers: new Map(),
    defaultMaxReauthReq: 2,
    defaultHoldMs: 60_000,
  };
}

export function defaultPortRuntime(port: string, mode: Dot1xPortMode = 'auto'): Dot1xPortRuntime {
  const state: Dot1xPortState =
    mode === 'force-authorized' ? 'force-authorized'
      : mode === 'force-unauthorized' ? 'force-unauthorized'
      : 'unauthorized';
  return {
    port, mode, state,
    identity: null, pendingEapId: null, lastSupplicantMac: null,
    radiusState: null,
    reauthCount: 0,
    lastTransitionMs: Date.now(),
    maxReauthReq: 2,
    holdMs: 60_000,
    holdUntilMs: 0,
  };
}

export function isAuthorizedState(state: Dot1xPortState): boolean {
  return state === 'authorized' || state === 'force-authorized';
}
