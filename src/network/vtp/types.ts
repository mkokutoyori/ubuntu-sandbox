import type { NetworkPdu } from '@/network/core/NetworkPdu';
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
  };
}

export function hashPassword(domain: string, password: string): string {
  if (!password) return '';
  let h = 0;
  const s = `${domain}|${password}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return `vtp:${h.toString(16)}`;
}
