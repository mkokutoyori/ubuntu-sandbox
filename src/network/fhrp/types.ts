/**
 * Shared vocabulary of the First-Hop Redundancy Protocol family
 * (HSRP, VRRP, GLBP). SRP: data shapes + pure helpers only.
 */
import type { EthernetFrame } from '../core/types';
import type { Port } from '../hardware/Port';

/** Device-side seam every FHRP agent speaks to (DIP: no Router import). */
export interface FhrpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): Port | undefined;
  getPorts(): Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
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
}

export interface FhrpConfigBase<G extends FhrpGroupBase> {
  enabled: boolean;
  groups: Map<string, G>;
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
