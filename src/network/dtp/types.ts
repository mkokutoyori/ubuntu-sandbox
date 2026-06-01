export const ETHERTYPE_DTP = 0x2004;
export const DTP_MULTICAST_MAC = '01:00:0c:cc:cc:cc';

export type DtpAdminMode =
  | 'access'
  | 'trunk'
  | 'dynamic-auto'
  | 'dynamic-desirable'
  | 'nonegotiate';

export type DtpOperationalMode = 'access' | 'trunk';

export interface DtpFrame {
  type: 'dtp';
  domain: string;
  adminMode: DtpAdminMode;
  operationalMode: DtpOperationalMode;
  trunkEncapsulation: 'dot1q' | 'isl' | 'negotiated';
  neighborMac: string;
}

export interface DtpPortState {
  adminMode: DtpAdminMode;
  operationalMode: DtpOperationalMode;
  trunkEncapsulation: 'dot1q' | 'isl' | 'negotiated';
  peerAdminMode: DtpAdminMode | null;
  peerMac: string | null;
  lastHelloMs: number;
}

export interface DtpConfig {
  enabled: boolean;
  helloSec: number;
  domain: string;
  ports: Map<string, DtpPortState>;
}

export function createDefaultDtpConfig(): DtpConfig {
  return {
    enabled: true,
    helloSec: 30,
    domain: '',
    ports: new Map(),
  };
}

export function defaultPortState(adminMode: DtpAdminMode = 'access'): DtpPortState {
  return {
    adminMode,
    operationalMode: adminMode === 'trunk' || adminMode === 'nonegotiate' ? 'trunk' : 'access',
    trunkEncapsulation: 'negotiated',
    peerAdminMode: null,
    peerMac: null,
    lastHelloMs: 0,
  };
}

export function resolveOperationalMode(
  local: DtpAdminMode,
  peer: DtpAdminMode | null,
): DtpOperationalMode {
  if (local === 'access') return 'access';
  if (local === 'trunk') return 'trunk';
  if (local === 'nonegotiate') return 'trunk';
  if (peer === null) return 'access';
  if (peer === 'access') return 'access';
  if (peer === 'trunk' || peer === 'nonegotiate') return 'trunk';
  if (peer === 'dynamic-desirable') return 'trunk';
  if (peer === 'dynamic-auto') {
    return local === 'dynamic-desirable' ? 'trunk' : 'access';
  }
  return 'access';
}

export function shouldEmitDtp(adminMode: DtpAdminMode): boolean {
  return adminMode === 'dynamic-auto'
      || adminMode === 'dynamic-desirable'
      || adminMode === 'trunk'
      || adminMode === 'access';
}
