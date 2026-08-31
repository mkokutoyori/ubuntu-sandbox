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
   * 802.1AX §6.4.15 : le port a un partenaire, mais ce partenaire n'est
   * pas celui du groupe d'agregation ACTIF — deux voisins distincts font
   * deux LAG, et un seul peut porter le trafic. IOS l'ecrit `s`
   * (suspended), le noyau le laisse simplement hors de l'agregateur.
   */
  | 'suspended'
  /**
   * 802.3ad §43.4.12: no LACPDU from the partner within current_while
   * (3 × the requested interval). The port has left the aggregate;
   * partner info survives one short interval longer, then is defaulted.
   */
  | 'expired';

/**
 * Churn machine states, 802.3ad §43.4.17. The kernel spells them
 * `monitoring` / `churned` / `none` in `bond_3ad_churn_desc`, which is
 * what `/proc/net/bonding` prints.
 */
export type LacpChurnState = 'monitoring' | 'churned' | 'none';

/**
 * `ad_select` du pilote bonding : laquelle des agregations candidates
 * porte le trafic quand il y en a plusieurs. `stable` ne remplace pas
 * l'active tant qu'elle repond, `bandwidth` prend la plus large,
 * `count` la plus nombreuse puis la plus large.
 */
export type LacpAggregatorSelection = 'stable' | 'bandwidth' | 'count';

export const AD_DUPLEX_KEY_MASK = 0x1;
export const AD_SPEED_KEY_MASK = 0x3e;
export const AD_USER_KEY_MASK = 0xffc0;

const AD_LINK_SPEED_CODES: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [10, 2], [100, 3], [1000, 4], [2500, 5], [5000, 6], [10000, 7],
  [14000, 8], [20000, 9], [25000, 10], [40000, 11], [50000, 12], [56000, 13],
  [80000, 14], [100000, 15], [200000, 16], [400000, 17], [800000, 18],
  [1600000, 19],
];

export function adLinkSpeedCode(mbps: number | null): number {
  if (mbps === null) return 0;
  const found = AD_LINK_SPEED_CODES.find(([speed]) => speed === mbps);
  return found ? found[1] : 0;
}

export function adOperPortKey(
  userKey: number, mbps: number | null, duplex: 'full' | 'half' | null,
): number {
  const user = (userKey << 6) & AD_USER_KEY_MASK;
  if (mbps === null || duplex === null) return user;
  return user | ((adLinkSpeedCode(mbps) << 1) & AD_SPEED_KEY_MASK)
    | (duplex === 'full' ? AD_DUPLEX_KEY_MASK : 0);
}

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
  churnActorState: LacpChurnState;
  churnPartnerState: LacpChurnState;
  churnActorCount: number;
  churnPartnerCount: number;
  /** 0 when the machine has already settled and is not counting down. */
  fastRate: boolean | null;
  churnActorDeadlineMs: number;
  churnPartnerDeadlineMs: number;
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
  adSelect: LacpAggregatorSelection;
  /** LAG identity of the aggregator currently carrying traffic. */
  activeLag: string | null;
}

export interface LacpConfig {
  enabled: boolean;
  systemPriority: number;
  systemId: string;
  fastRate: boolean;
  defaultPortPriority: number;
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
    defaultPortPriority: 32768,
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
