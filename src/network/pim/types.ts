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

export interface PimPacket {
  type: 'pim';
  version: 2;
  messageType: PimMessageType;
  reserved: number;
  checksum: number;
  options: PimHelloOption[];
  senderIp: string;
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
}

export function makeNeighborKey(iface: string, neighborIp: string): string {
  return `${iface}|${neighborIp}`;
}

export function createDefaultPimConfig(): PimConfig {
  return { enabled: true, interfaces: new Map(), neighbors: new Map() };
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
