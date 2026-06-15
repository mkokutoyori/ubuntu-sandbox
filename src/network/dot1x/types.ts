import type { NetworkPdu } from '@/network/core/NetworkPdu';
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

export type EapCode = 'request' | 'response' | 'success' | 'failure';

export const EAP_CODE: Record<EapCode, number> = {
  request: 1,
  response: 2,
  success: 3,
  failure: 4,
};

export type EapType =
  | 'identity'
  | 'notification'
  | 'nak'
  | 'md5-challenge'
  | 'tls'
  | 'peap';

export const EAP_TYPE: Record<EapType, number> = {
  identity: 1,
  notification: 2,
  nak: 3,
  'md5-challenge': 4,
  tls: 13,
  peap: 25,
};

export interface EapPacket extends NetworkPdu {
  type: 'eap';
  code: EapCode;
  identifier: number;
  eapType?: EapType;
  payload?: string;
}

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
