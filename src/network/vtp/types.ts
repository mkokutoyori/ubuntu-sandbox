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
  /** Updater Identity — the IP of whoever last changed the shared VLAN
   *  database (real Cisco: the management interface, or failing that the
   *  lowest-numbered active VLAN SVI). Distinct from `VtpConfig.updaterMac`,
   *  which is the sending device's own fixed chassis ID ("Device ID" in
   *  `show vtp status`) and never travels on the wire. */
  updater: string;
  /** Epoch ms of the last revision increment this frame reflects. */
  updateTimestamp: number;
  /** Summary only: how many Subset Advertisements follow it. */
  followers?: number;
  /** Subset only: 1-based position among `followers` — a receiver buffers
   *  every fragment for a given domain/revision and only applies the VLAN
   *  diff once all of them have arrived (real VTP's own reassembly rule). */
  sequenceNumber?: number;
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
  /** Local device's own fixed MAC — "Device ID" in `show vtp status`.
   *  Never overwritten by a peer's advertisement. */
  updaterMac: string;
  /** IP of whoever last changed the shared VLAN database — local
   *  (stamped from `vtpUpdaterIdentity()` on a local change) or learned
   *  (copied from an accepted Summary/Subset's `updater` field). */
  lastUpdaterIdentity: string;
  /** Epoch ms paired with `lastUpdaterIdentity`. */
  lastUpdateTimestamp: number;
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
    lastUpdaterIdentity: '0.0.0.0',
    lastUpdateTimestamp: 0,
    primaryServer: false,
  };
}

export function hashPassword(domain: string, password: string): string {
  if (!password) return '';
  return md5Hex(`${domain}|${password}`);
}
