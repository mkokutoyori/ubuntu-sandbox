import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const ETHERTYPE_LACP = 0x8809;
export const LACP_SLOW_MAC = '01:80:c2:00:00:02';

export type LacpAdminMode = 'on' | 'active' | 'passive';
export type LacpPortState =
  | 'standalone'
  | 'sync'
  | 'collecting'
  | 'distributing'
  | 'bundled'
  /**
   * 802.1AX §6.7.1 : le port a un partenaire compatible mais l'agregat
   * a deja son compte de liens ; il attend qu'une place se libere.
   */
  | 'standby'
  /**
   * 802.3ad §43.4.12: no LACPDU from the partner within current_while
   * (3 × the requested interval). The port has left the aggregate;
   * partner info survives one short interval longer, then is defaulted.
   */
  | 'expired';

export interface LacpActorInfo {
  systemPriority: number;
  systemId: string;
  key: number;
  portPriority: number;
  portNumber: number;
  state: number;
}

export const MARKER_INFORMATION = 0x01;
export const MARKER_RESPONSE = 0x02;

/**
 * Marker Protocol Data Unit, 802.3ad §43.5.3.2. It travels on the same
 * slow-protocol ethertype and group address as an LACPDU and is told
 * apart by its subtype (0x02 against the LACPDU's 0x01).
 */
export interface MarkerFrame extends NetworkPdu {
  type: 'lacp-marker';
  subtype: 0x02;
  version: 0x01;
  tlvType: typeof MARKER_INFORMATION | typeof MARKER_RESPONSE;
  markerLength: 0x16;
  requesterPort: number;
  requesterSystem: string;
  requesterTransactionId: number;
}

export interface LacpFrame extends NetworkPdu {
  type: 'lacp';
  subtype: 0x01;
  version: 0x01;
  actor: LacpActorInfo;
  partner: LacpActorInfo;
  collectorMaxDelay: number;
}

export interface LacpPortInfo {
  portName: string;
  groupId: number;
  mode: LacpAdminMode;
  /**
   * Advertised in every LACPDU. It is what the partner reads to break
   * ties when it has more candidates than it can bundle; this engine
   * has no bundle-size cap of its own, so the value travels rather than
   * arbitrating locally.
   */
  portPriority: number;
  state: LacpPortState;
  partner: LacpActorInfo | null;
  selected: boolean;
  bundled: boolean;
  lastRxMs: number;
}

export interface LacpGroup {
  name: string;
  loadBalance: string;
  /** 802.1AX: below this many bundled links the aggregate does not carry. */
  minLinks: number;
  /** Above this many, the extra candidates wait in standby. 0 = no cap. */
  maxLinks: number;
  /**
   * VRP `lacp preempt`: when off, a port that already holds a slot keeps
   * it even if a higher-priority candidate turns up.
   */
  preempt: boolean;
  preemptDelay: number;
}

export interface LacpConfig {
  enabled: boolean;
  systemPriority: number;
  systemId: string;
  fastRate: boolean;
  loadBalance: string;
  ports: Map<string, LacpPortInfo>;
  groups: Map<number, LacpGroup>;
}

export function createDefaultLacpConfig(systemId: string): LacpConfig {
  return {
    enabled: true,
    systemPriority: 32768,
    systemId: systemId.toLowerCase(),
    fastRate: false,
    loadBalance: 'src-dst-ip',
    ports: new Map(),
    groups: new Map(),
  };
}

export const LACP_FLAG_ACTIVITY = 0x01;
export const LACP_FLAG_TIMEOUT = 0x02;
export const LACP_FLAG_AGGREGATION = 0x04;
export const LACP_FLAG_SYNC = 0x08;
export const LACP_FLAG_COLLECTING = 0x10;
export const LACP_FLAG_DISTRIBUTING = 0x20;
export const LACP_FLAG_DEFAULTED = 0x40;
export const LACP_FLAG_EXPIRED = 0x80;

export function buildActorState(
  mode: LacpAdminMode, port: LacpPortInfo, fastRate = false,
): number {
  let f = 0;
  if (mode === 'active') f |= LACP_FLAG_ACTIVITY;
  if (fastRate) f |= LACP_FLAG_TIMEOUT;
  f |= LACP_FLAG_AGGREGATION;
  if (port.selected) f |= LACP_FLAG_SYNC;
  if (port.state === 'collecting' || port.state === 'distributing' || port.state === 'bundled') {
    f |= LACP_FLAG_COLLECTING;
  }
  if (port.state === 'distributing' || port.state === 'bundled') {
    f |= LACP_FLAG_DISTRIBUTING;
  }
  if (!port.partner) f |= LACP_FLAG_DEFAULTED;
  if (port.state === 'expired') f |= LACP_FLAG_EXPIRED;
  return f;
}

export function partnerWantsFastRate(state: number): boolean {
  return (state & LACP_FLAG_TIMEOUT) !== 0;
}

export function lacpStateBits(state: number): string {
  const ordre = [
    LACP_FLAG_ACTIVITY, LACP_FLAG_TIMEOUT, LACP_FLAG_AGGREGATION, LACP_FLAG_SYNC,
    LACP_FLAG_COLLECTING, LACP_FLAG_DISTRIBUTING, LACP_FLAG_DEFAULTED, LACP_FLAG_EXPIRED,
  ];
  return ordre.map(bit => ((state & bit) !== 0 ? '1' : '0')).join('');
}

export function compareSystemId(a: { priority: number; id: string }, b: { priority: number; id: string }): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
}
