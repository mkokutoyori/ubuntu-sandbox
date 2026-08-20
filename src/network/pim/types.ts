import type { NetworkPdu } from '@/network/core/NetworkPdu';
import { ipToUint32, prefixLengthToMaskUint32 } from '../core/ip';
export const IP_PROTO_PIM = 103;
export const PIM_ALL_ROUTERS = '224.0.0.13';
export const PIM_ALL_ROUTERS_MAC = '01:00:5e:00:00:0d';

export type PimMessageType =
  | 'hello'
  | 'join-prune'
  | 'bootstrap'
  | 'candidate-rp-advertisement';

export type PimMode = 'sparse' | 'dense' | 'sparse-dense';

export interface PimHelloOption {
  type: 'holdtime' | 'lan-prune-delay' | 'dr-priority' | 'generation-id' | 'state-refresh' | 'address-list';
  value: number | string | string[];
}

export interface PimJoinPruneGroup {
  groupAddress: string;
  joinedSources: string[];
  prunedSources: string[];
  joinStarG: boolean;
  pruneStarG: boolean;
}

export interface PimJoinPruneBody {
  upstreamNeighborIp: string;
  holdtimeSec: number;
  groups: PimJoinPruneGroup[];
}

export interface PimPacket extends NetworkPdu {
  type: 'pim';
  version: 2;
  messageType: PimMessageType;
  reserved: number;
  checksum: number;
  options: PimHelloOption[];
  senderIp: string;
  joinPrune?: PimJoinPruneBody;
  bootstrap?: PimBootstrapBody;
  candidateRp?: PimCandidateRpBody;
}

export type PimMroutEntryType = 'star-g';

export interface PimMroutEntry {
  groupAddress: string;
  sourceAddress: string | null;
  entryType: PimMroutEntryType;
  incomingInterface: string | null;
  upstreamNeighborIp: string | null;
  rpAddress: string | null;
  outgoingInterfaces: Set<string>;
  joinExpiryMs: number;
  uptimeMs: number;
  lastJoinSentMs: number;
}

export function makeMroutKey(group: string, source: string | null): string {
  return `${source ?? '*'}|${group}`;
}

export interface PimRpEntry {
  rpAddress: string;
  groupRangeAddress: string;
  groupRangeMaskBits: number;
  isStatic: boolean;
  /** Candidate-RP priority — lower wins (RFC 5059 §3.2). BSR entries only. */
  priority?: number;
  /** Absolute deadline after which a BSR-learned entry is dropped. */
  expiresMs?: number;
}

/** A Bootstrap Router candidate: higher priority wins, then higher IP. */
export interface PimBsrCandidate {
  address: string;
  priority: number;
}

/**
 * RFC 5059 §3.1: higher BSR priority wins; on a tie the higher IP address
 * wins. Same shape as `compareDrCandidate` — negative means `a` wins.
 */
export function compareBsrCandidate(a: PimBsrCandidate, b: PimBsrCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ai = a.address.split('.').map(Number);
  const bi = b.address.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return bi[i] - ai[i];
  return 0;
}

/** Body of a Bootstrap message: the BSR's whole group-to-RP set. */
export interface PimBootstrapBody {
  bsrAddress: string;
  bsrPriority: number;
  /** Increments on each origination; a stale fragment is ignored. */
  fragmentTag: number;
  groups: Array<{
    groupRangeAddress: string;
    groupRangeMaskBits: number;
    rps: Array<{ rpAddress: string; priority: number; holdtimeSec: number }>;
  }>;
}

/** Body of a Candidate-RP-Advertisement, unicast to the elected BSR. */
export interface PimCandidateRpBody {
  rpAddress: string;
  priority: number;
  holdtimeSec: number;
  groups: Array<{ groupRangeAddress: string; groupRangeMaskBits: number }>;
}

export interface PimNeighborEntry {
  iface: string;
  neighborIp: string;
  helloHoldSec: number;
  drPriority: number;
  generationId: number;
  hasDrPriorityOption: boolean;
  lastHeardMs: number;
  upSinceMs: number;
  addressList: string[];
}

export interface PimInterfaceRuntime {
  iface: string;
  enabled: boolean;
  mode: PimMode;
  helloIntervalSec: number;
  helloHoldSec: number;
  drPriority: number;
  generationId: number;
  designatedRouterIp: string | null;
  lastHelloSentMs: number;
}

export interface PimConfig {
  enabled: boolean;
  interfaces: Map<string, PimInterfaceRuntime>;
  neighbors: Map<string, PimNeighborEntry>;
  /** Operator-configured RPs (`ip pim rp-address` / `static-rp`). */
  rps: PimRpEntry[];
  /** RPs learned from a Bootstrap message; never mixed with `rps`. */
  learnedRps: PimRpEntry[];
  mroutes: Map<string, PimMroutEntry>;
  joinPruneIntervalSec: number;
  joinPruneHoldtimeSec: number;
  /** This router's own C-BSR configuration, if any. */
  bsrCandidate: PimBsrCandidate | null;
  /** The BSR currently in force on the domain, elected or accepted. */
  currentBsr: PimBsrCandidate | null;
  /** When the current BSR was last heard from; null if it is us. */
  lastBsrHeardMs: number | null;
  /** This router's own C-RP configuration, if any. */
  rpCandidate: { address: string; priority: number; groupRangeAddress: string; groupRangeMaskBits: number } | null;
  /** Candidate-RPs this router has collected while acting as the BSR. */
  candidateRps: Map<string, { rp: PimRpEntry; expiresMs: number }>;
  bootstrapIntervalSec: number;
  bootstrapTimeoutSec: number;
  candidateRpIntervalSec: number;
  bootstrapFragmentTag: number;
  lastBootstrapSentMs: number | null;
  lastCandidateRpSentMs: number | null;
}

export function makeNeighborKey(iface: string, neighborIp: string): string {
  return `${iface}|${neighborIp}`;
}

export function createDefaultPimConfig(): PimConfig {
  return {
    enabled: true,
    interfaces: new Map(),
    neighbors: new Map(),
    rps: [],
    learnedRps: [],
    mroutes: new Map(),
    joinPruneIntervalSec: 60,
    joinPruneHoldtimeSec: 210,
    bsrCandidate: null,
    currentBsr: null,
    lastBsrHeardMs: null,
    rpCandidate: null,
    candidateRps: new Map(),
    // RFC 5059 §5: BS_Period 60 s, BS_Timeout 130 s, C-RP_Adv_Period 60 s.
    bootstrapIntervalSec: 60,
    bootstrapTimeoutSec: 130,
    candidateRpIntervalSec: 60,
    bootstrapFragmentTag: 0,
    lastBootstrapSentMs: null,
    lastCandidateRpSentMs: null,
  };
}

// Canonical implementation lives in core/ip; re-exported for existing callers.
export { ipToUint32 } from '../core/ip';

export function matchesGroupRange(group: string, rangeIp: string, maskBits: number): boolean {
  if (maskBits <= 0) return true;
  const mask = prefixLengthToMaskUint32(maskBits);
  return (ipToUint32(group) & mask) === (ipToUint32(rangeIp) & mask);
}

export function defaultInterfaceRuntime(iface: string, mode: PimMode = 'sparse'): PimInterfaceRuntime {
  return {
    iface, enabled: false, mode,
    helloIntervalSec: 30, helloHoldSec: 105,
    drPriority: 1, generationId: Math.floor(Math.random() * 0xffffffff),
    designatedRouterIp: null, lastHelloSentMs: 0,
  };
}

export function compareDrCandidate(
  a: { drPriority: number; hasDrPriority: boolean; ip: string },
  b: { drPriority: number; hasDrPriority: boolean; ip: string },
): number {
  const anyMissing = !a.hasDrPriority || !b.hasDrPriority;
  if (!anyMissing && a.drPriority !== b.drPriority) {
    return b.drPriority - a.drPriority;
  }
  const ai = a.ip.split('.').map(Number);
  const bi = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ai[i] !== bi[i]) return bi[i] - ai[i];
  return 0;
}

export function getOption<T>(opts: PimHelloOption[], type: PimHelloOption['type']): T | undefined {
  const o = opts.find(x => x.type === type);
  return o?.value as T | undefined;
}
