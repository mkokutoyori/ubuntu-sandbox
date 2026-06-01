export const IP_PROTO_PIM = 103;
export const PIM_ALL_ROUTERS = '224.0.0.13';
export const PIM_ALL_ROUTERS_MAC = '01:00:5e:00:00:0d';

export type PimMessageType =
  | 'hello'
  | 'register'
  | 'register-stop'
  | 'join-prune'
  | 'bootstrap'
  | 'assert'
  | 'graft'
  | 'graft-ack'
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

export interface PimPacket {
  type: 'pim';
  version: 2;
  messageType: PimMessageType;
  reserved: number;
  checksum: number;
  options: PimHelloOption[];
  senderIp: string;
  joinPrune?: PimJoinPruneBody;
}

export type PimMroutEntryType = 'star-g' | 's-g';

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
  rps: PimRpEntry[];
  mroutes: Map<string, PimMroutEntry>;
  joinPruneIntervalSec: number;
  joinPruneHoldtimeSec: number;
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
    mroutes: new Map(),
    joinPruneIntervalSec: 60,
    joinPruneHoldtimeSec: 210,
  };
}

export function ipToUint32(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function matchesGroupRange(group: string, rangeIp: string, maskBits: number): boolean {
  if (maskBits <= 0) return true;
  const mask = (0xffffffff << (32 - maskBits)) >>> 0;
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
