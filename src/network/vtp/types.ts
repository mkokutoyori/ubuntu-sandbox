import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { md5Hex } from '@/crypto';
export const ETHERTYPE_VTP = 0x2003;
export const VTP_MULTICAST_MAC = '01:00:0c:cc:cc:cc';

export type VtpMode = 'server' | 'client' | 'transparent' | 'off';
export type VtpVersion = 1 | 2 | 3;
export type VtpMessageType = 'summary' | 'subset' | 'request' | 'join';

export interface VtpVlanEntry {
  id: number;
  name: string;
  mtu: number;
  type: 'ethernet';
}

export interface VtpFrame extends NetworkPdu {
  type: 'vtp';
  version: VtpVersion;
  messageType: VtpMessageType;
  domain: string;
  revision: number;
  updater: string;
  passwordHash: string;
  vlans: VtpVlanEntry[];
  interestVlans?: number[];
  primaryClaim?: { updater: string; revision: number; forced: boolean };
}

export interface VtpConfig {
  enabled: boolean;
  domain: string;
  password: string;
  mode: VtpMode;
  version: VtpVersion;
  revision: number;
  pruning: boolean;
  updaterMac: string;
  primaryServer: boolean;
}

export function createDefaultVtpConfig(systemMac: string): VtpConfig {
  return {
    enabled: true,
    domain: '',
    password: '',
    mode: 'server',
    version: 1,
    revision: 0,
    pruning: false,
    updaterMac: systemMac.toLowerCase(),
    primaryServer: false,
  };
}

export function hashPassword(domain: string, password: string): string {
  if (!password) return '';
  return md5Hex(`${domain}|${password}`);
}
