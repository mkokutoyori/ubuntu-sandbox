import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_NTP = 123;

export type NtpMode = 'client' | 'server' | 'symmetric-active' | 'symmetric-passive';
export type NtpLeapIndicator = 0 | 1 | 2 | 3;

export interface NtpPacket extends NetworkPdu {
  type: 'ntp';
  leapIndicator: NtpLeapIndicator;
  version: 4;
  mode: NtpMode;
  stratum: number;
  poll: number;
  precision: number;
  rootDelay: number;
  rootDispersion: number;
  refIdentifier: string;
  refTimestampMs: number;
  origTimestampMs: number;
  rxTimestampMs: number;
  txTimestampMs: number;
  keyId?: number;
}

export interface NtpAssociation {
  serverIp: string;
  mode: NtpMode;
  preferred: boolean;
  prefer: boolean;
  stratum: number;
  reach: number;
  pollSec: number;
  delayMs: number;
  offsetMs: number;
  dispersionMs: number;
  lastPollMs: number;
  lastReplyMs: number;
  synced: boolean;
  keyId?: number;
}

export interface NtpAuthKey {
  id: number;
  algo: string;
  key: string;
}

export interface NtpConfig {
  enabled: boolean;
  serverMode: boolean;
  associations: Map<string, NtpAssociation>;
  localStratum: number;
  offsetMs: number;
  lastSyncMs: number;
  refIdentifier: string;
  sourceInterface: string;
  authenticate: boolean;
  authKeys: Map<number, NtpAuthKey>;
  trustedKeys: Set<number>;
  accessGroups: Map<string, string>;
}

export function createDefaultNtpConfig(): NtpConfig {
  return {
    enabled: true,
    serverMode: false,
    associations: new Map(),
    localStratum: 16,
    offsetMs: 0,
    lastSyncMs: 0,
    refIdentifier: '.INIT.',
    sourceInterface: '',
    authenticate: false,
    authKeys: new Map(),
    trustedKeys: new Set(),
    accessGroups: new Map(),
  };
}

export function defaultAssociation(serverIp: string, prefer = false, mode: NtpMode = 'client'): NtpAssociation {
  return {
    serverIp, mode, preferred: false, prefer,
    stratum: 16, reach: 0, pollSec: 64,
    delayMs: 0, offsetMs: 0, dispersionMs: 16000,
    lastPollMs: 0, lastReplyMs: 0, synced: false,
  };
}

export function computeOffsetMs(
  t1: number, t2: number, t3: number, t4: number,
): { offset: number; delay: number } {
  const offset = ((t2 - t1) + (t3 - t4)) / 2;
  const delay = (t4 - t1) - (t3 - t2);
  return { offset, delay };
}
