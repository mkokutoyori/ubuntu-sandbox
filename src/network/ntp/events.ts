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

export interface NtpPeerRespondedPayload extends NtpDeviceRef {
  peerIp: string;
  mode: NtpMode;
  stratum: number;
}

export interface NtpAuthRejectedPayload extends NtpDeviceRef {
  fromIp: string;
  /**
   * `bad-mac` (lot N5) est le seul des quatre qui denonce une
   * USURPATION plutot qu'une faute de configuration : le numero de clé
   * est bon, elle est declaree fiable, et le condensé ne correspond pas.
   */
  reason: 'no-key' | 'untrusted-key' | 'unconfigured' | 'bad-mac';
}

export type NtpDomainEvent =
  | { topic: 'ntp.packet.sent'; payload: NtpPacketSentPayload }
  | { topic: 'ntp.packet.received'; payload: NtpPacketReceivedPayload }
  | { topic: 'ntp.synced'; payload: NtpSyncedPayload }
  | { topic: 'ntp.unsynced'; payload: NtpUnsyncedPayload }
  | { topic: 'ntp.server.responded'; payload: NtpServerRespondedPayload }
  | { topic: 'ntp.peer.responded'; payload: NtpPeerRespondedPayload }
  | { topic: 'ntp.auth.rejected'; payload: NtpAuthRejectedPayload }
  | { topic: 'ntp.access.denied'; payload: NtpAccessDeniedPayload };

/**
 * Un paquet ecarte par `ntp access-group` (lot N6).
 *
 * `action` dit ce que la source DEMANDAIT, et c'est ce qui rend
 * l'evenement utile : « refuse » ne se diagnostique pas de la meme
 * facon selon qu'un client demandait l'heure ou qu'un serveur proposait
 * la sienne.
 */
export interface NtpAccessDeniedPayload extends NtpDeviceRef {
  fromIp: string;
  action: 'serve-time' | 'sync-from' | 'control-query';
}
