/**
 * Shared vocabulary of the First-Hop Redundancy Protocol family
 * (HSRP, VRRP, GLBP). SRP: data shapes + pure helpers only.
 */
import type { EthernetFrame } from '../core/types';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import type { Port } from '../hardware/Port';

/** Device-side seam every FHRP agent speaks to (DIP: no Router import). */
export interface FhrpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): Port | undefined;
  getPorts(): Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
}

/** Why a group's state machine was re-evaluated. */
export type FhrpRecomputeReason =
  | 'config' | 'peer' | 'timeout' | 'priority' | 'preempt';

/** The fields the family's shared machinery relies on. */
export interface FhrpGroupBase {
  iface: string;
  vip: string | null;
  priority: number;
  preempt: boolean;
  /**
   * `preempt delay minimum <s>` (IOS) / `preempt-mode timer delay <s>`
   * (VRP) : combien de temps ce routeur doit rester ELIGIBLE avant de
   * prendre le role a un pair vivant de priorite moindre.
   *
   * Le reglage vit sur la BASE et non sur chaque protocole parce que les
   * trois familles l'ont, sous trois orthographes, et que c'est la meme
   * decision. Il etait range par les trois CLI dans trois facades que
   * seuls les affichages lisaient — donc inerte partout.
   */
  preemptDelaySec?: number;
  /**
   * Depuis quand ce routeur est eligible ; `null` quand il ne l'est pas.
   * C'est ce qui rend le delai reel plutot que decoratif.
   */
  preemptEligibleSinceMs?: number | null;
}

export interface FhrpConfigBase<G extends FhrpGroupBase> {
  enabled: boolean;
  groups: Map<string, G>;
}

/**
 * Data-plane surface every FHRP agent exposes to its owning router.
 * Without it the protocols are control-plane theatre: hosts using the
 * VIP as gateway could never resolve it (RFC 5798 §8.1.2, RFC 2281 §5.3).
 */
export interface FhrpDataPlane {
  /**
   * Virtual MAC to put in an ARP reply for `targetIp` received on
   * `iface`, or null when this device must stay silent (not the
   * active/master/AVG, or no group owns the VIP). `requesterIp` feeds
   * GLBP's per-client load balancing.
   */
  vipArpOwner(iface: string, targetIp: string, requesterIp: string): string | null;
  /** True when frames addressed to `dstMac` on `iface` must be accepted and routed. */
  ownsVirtualMac(iface: string, dstMac: string): boolean;
  /** True when `ip` is a VIP this device currently answers for (ICMP echo to the VIP). */
  ownsVip(iface: string, ip: string): boolean;
}

/**
 * Wire/runtime MAC representation: lowercase colon-separated.
 * Accepts Cisco dotted display format (0000.0c07.ac01) used by the
 * HSRP helpers so the same constant serves `show standby` and the wire.
 */
export function normalizeVirtualMac(mac: string): string {
  const hex = mac.replace(/[.:-]/g, '').toLowerCase();
  return hex.match(/.{2}/g)?.join(':') ?? mac.toLowerCase();
}

/**
 * Election comparison shared by the whole family: highest priority
 * wins, then highest interface IP (HSRP/VRRP/GLBP all tie-break the
 * same way). Negative when `a` beats `b`.
 */
export function compareFhrpCandidates(
  a: { priority: number; ip: string },
  b: { priority: number; ip: string },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ai = a.ip.split('.').map(Number);
  const bi = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return bi[i] - ai[i];
  return 0;
}

export interface FhrpTrackEntry {
  target: string;
  decrement: number;
  down: boolean;
}

export function makeFhrpKey(iface: string, group: number): string {
  return `${iface}|${group}`;
}

export function createDefaultFhrpConfig<G extends FhrpGroupBase>(): FhrpConfigBase<G> {
  return { enabled: true, groups: new Map() };
}

/**
 * Priority after applying object-tracking decrements, clamped to the
 * protocol's legal range (HSRP 0-255, VRRP owner-reserved 1-254).
 */
export function trackedPriority(
  base: number, tracks: readonly FhrpTrackEntry[], min: number, max: number,
): number {
  let p = base;
  for (const t of tracks) if (t.down) p -= t.decrement;
  if (p < min) p = min;
  if (p > max) p = max;
  return p;
}
