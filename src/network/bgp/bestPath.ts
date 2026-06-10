/**
 * BGP best-path selection (RFC 4271 §9.1.1 + Cisco's weight step).
 *
 * Decision order implemented:
 *   1. Highest weight (Cisco-proprietary, local to the router)
 *   2. Highest LOCAL_PREF
 *   3. Locally originated (network/aggregate) over learned
 *   4. Shortest AS_PATH
 *   5. Lowest origin (IGP < EGP < incomplete)
 *   6. Lowest MED — only between paths from the same neighbouring AS
 *   7. eBGP over iBGP
 *   8. (IGP metric to next hop — not modelled, skipped)
 *   9. Lowest peer router-id
 *  10. Lowest peer IP address
 *
 * SRP: pure comparison logic only — no engine/topology knowledge.
 */
import type { RibRoute } from '../routing/types';

export type BgpOrigin = 'igp' | 'egp' | 'incomplete';

/** Default LOCAL_PREF advertised within an AS (Cisco/Juniper default). */
export const BGP_DEFAULT_LOCAL_PREF = 100;
/** Cisco default weight for locally originated paths. */
export const BGP_WEIGHT_LOCAL = 32768;

const ORIGIN_RANK: Record<BgpOrigin, number> = { igp: 0, egp: 1, incomplete: 2 };

export interface BgpPathCandidate {
  readonly route: RibRoute;
  /** Cisco weight (0 default, 32768 locally originated). */
  readonly weight: number;
  readonly localPref: number;
  readonly locallyOriginated: boolean;
  /** AS_PATH as received (leftmost = neighbouring AS). */
  readonly asPath: readonly number[];
  readonly origin: BgpOrigin;
  readonly med: number;
  readonly isEbgp: boolean;
  readonly peerRouterId: string;
  readonly peerIp: string;
}

function compareIpStrings(a: string, b: string): number {
  const ao = a.split('.').map(Number);
  const bo = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if ((ao[i] ?? 0) !== (bo[i] ?? 0)) return (ao[i] ?? 0) - (bo[i] ?? 0);
  }
  return 0;
}

/**
 * RFC 4271 ordering: negative when `a` is preferred over `b`.
 * MED is only compared when both paths enter via the same
 * neighbouring AS (first AS of the path), per §9.1.2.2 c).
 */
export function compareBgpPaths(
  a: BgpPathCandidate, b: BgpPathCandidate,
): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.localPref !== b.localPref) return b.localPref - a.localPref;
  if (a.locallyOriginated !== b.locallyOriginated) {
    return a.locallyOriginated ? -1 : 1;
  }
  if (a.asPath.length !== b.asPath.length) {
    return a.asPath.length - b.asPath.length;
  }
  if (a.origin !== b.origin) {
    return ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
  }
  const sameNeighbouringAs = a.asPath[0] !== undefined
    && a.asPath[0] === b.asPath[0];
  if (sameNeighbouringAs && a.med !== b.med) return a.med - b.med;
  if (a.isEbgp !== b.isEbgp) return a.isEbgp ? -1 : 1;
  const byRouterId = compareIpStrings(a.peerRouterId, b.peerRouterId);
  if (byRouterId !== 0) return byRouterId;
  return compareIpStrings(a.peerIp, b.peerIp);
}

/** The single best path among candidates (null for an empty set). */
export function selectBestPath(
  candidates: readonly BgpPathCandidate[],
): BgpPathCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareBgpPaths)[0];
}
