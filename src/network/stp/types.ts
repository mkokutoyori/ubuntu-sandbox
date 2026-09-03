export const ETHERTYPE_STP = 0x4242;
export const STP_BRIDGE_MAC = '01:80:c2:00:00:00';
/**
 * Cisco's proprietary PVST+/SSTP destination MAC. Real IOS sends the CST
 * BPDU on a trunk's native VLAN untagged to `STP_BRIDGE_MAC` like plain
 * 802.1D, but sends one extra, 802.1Q-tagged BPDU per non-native VLAN to
 * this address (LLC/SNAP-encapsulated on the wire) so a receiving switch's
 * hardware can tell "PVST+ per-VLAN hello" apart from the common tree BPDU
 * without needing to already know the trunk's VLAN membership.
 */
export const PVST_PLUS_MAC = '01:00:0c:cc:cc:cd';

export type StpBpduType = 'config' | 'tcn';
/**
 * Port roles per IEEE 802.1D-2004 §17.7. Classic 802.1D only names
 * root/designated/blocked, but the rapid (802.1w) role taxonomy
 * distinguishes the two kinds of blocked port — and Cisco/Huawei show
 * commands report them separately even in legacy mode:
 *  - `alternate`: blocked because a *different* bridge offers a better
 *    path to the root (an alternate path to the root port);
 *  - `backup`: blocked because *our own* bridge offers a superior BPDU
 *    on the same shared segment (backs up a local designated port).
 * Both are in the Discarding/Blocking forwarding state.
 */
export type StpPortRole =
  | 'root' | 'designated' | 'alternate' | 'backup' | 'disabled';

export interface BridgeId {
  priority: number;
  mac: string;
}

export type StpProtocolMode = 'stp' | 'rstp' | 'mstp';

export interface StpBpdu {
  type: 'stp';
  bpduType: StpBpduType;
  vlan?: number;
  cist?: boolean;
  protocolId: 0x0000;
  version: 0 | 2;
  flags: number;
  proposal?: boolean;
  agreement?: boolean;
  rootBridge: BridgeId;
  rootPathCost: number;
  senderBridge: BridgeId;
  portId: number;
  messageAgeSec: number;
  maxAgeSec: number;
  helloSec: number;
  forwardDelaySec: number;
  topologyChange: boolean;
  topologyChangeAck: boolean;
  mstConfigId?: { name: string; revision: number; digest: string };
}

export interface StpPortGuards {
  portFast: boolean;
  bpduGuard: boolean;
  rootGuard: boolean;
  /** `spanning-tree bpdufilter enable` — hard per-port override, independent of portfast state. */
  bpduFilter: boolean;
  /** `spanning-tree guard loop` — hard per-port override, independent of the `loopguard default` global. */
  loopGuard: boolean;
}

export function defaultPortGuards(): StpPortGuards {
  return {
    portFast: false, bpduGuard: false, rootGuard: false,
    bpduFilter: false, loopGuard: false,
  };
}

export interface StpConfig {
  enabled: boolean;
  /**
   * Les VLAN pour lesquels `no spanning-tree vlan <n>` a coupe l'arbre.
   *
   * C'est une notion PAR VLAN parce que la commande en nomme un :
   * `enabled` seul, qui est global, faisait couper tous les autres.
   */
  disabledVlans: Set<number>;
  mode: StpProtocolMode;
  bridgePriority: number;
  helloSec: number;
  maxAgeSec: number;
  forwardDelaySec: number;
  baseMac: string;
  bpduGuardGlobal: boolean;
  portfastDefault: boolean;
  bpduFilterGlobal: boolean;
  loopGuardGlobal: boolean;
  uplinkFast: boolean;
  backboneFast: boolean;
}

export interface MstRegion {
  name: string;
  revision: number;
  instances: Map<number, string>;
}

export function createDefaultMstRegion(): MstRegion {
  return { name: '', revision: 0, instances: new Map() };
}

/**
 * Parses the VLAN membership spec stored per MST instance, accepting both
 * Cisco's comma/hyphen syntax (`10,20-25`) and Huawei's space/"to" syntax
 * (`10 to 25 30`) since both shells write into the same MstRegion.
 */
export function parseStpVlanList(spec: string): number[] {
  const out = new Set<number>();
  const cleaned = spec.replace(/^vlan\s+/i, '').replace(/,/g, ' ').trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const hyphen = tok.match(/^(\d+)-(\d+)$/);
    if (hyphen) {
      for (let v = +hyphen[1]; v <= +hyphen[2]; v++) out.add(v);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      if (tokens[i + 1]?.toLowerCase() === 'to' && /^\d+$/.test(tokens[i + 2] ?? '')) {
        for (let v = +tok; v <= +tokens[i + 2]; v++) out.add(v);
        i += 2;
        continue;
      }
      out.add(+tok);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export interface StpPortInfo {
  role: StpPortRole;
  cost: number;
  designatedRoot: BridgeId;
  designatedBridge: BridgeId;
  designatedCost: number;
  designatedPort: number;
  ageMs: number;
  /**
   * Timers as advertised by whoever sent this BPDU. A non-root bridge runs
   * on the root's values, not on its own — that is what makes a Max Age or
   * Forward Delay set on the root take effect network-wide.
   */
  helloSec?: number;
  maxAgeSec?: number;
  forwardDelaySec?: number;
  /** Message Age carried by the BPDU, incremented at each relay. */
  messageAgeSec?: number;
}

export function createDefaultStpConfig(baseMac: string): StpConfig {
  return {
    enabled: true,
    disabledVlans: new Set<number>(),
    mode: 'stp',
    bridgePriority: 32768,
    helloSec: 2,
    maxAgeSec: 20,
    forwardDelaySec: 15,
    baseMac: baseMac.toLowerCase(),
    bpduGuardGlobal: false,
    portfastDefault: false,
    bpduFilterGlobal: false,
    loopGuardGlobal: false,
    uplinkFast: false,
    backboneFast: false,
  };
}

export function defaultPathCost(speedKbps: number): number {
  if (speedKbps >= 10_000_000) return 2;
  if (speedKbps >= 1_000_000) return 4;
  if (speedKbps >= 100_000) return 19;
  if (speedKbps >= 10_000) return 100;
  return 200;
}

export function defaultPathCostLong(speedKbps: number): number {
  if (speedKbps >= 10_000_000) return 2_000;
  if (speedKbps >= 1_000_000) return 20_000;
  if (speedKbps >= 100_000) return 200_000;
  if (speedKbps >= 10_000) return 2_000_000;
  return 20_000_000;
}

export function compareBridge(a: BridgeId, b: BridgeId): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const am = a.mac.toLowerCase();
  const bm = b.mac.toLowerCase();
  return am < bm ? -1 : am > bm ? 1 : 0;
}

export function bridgeEquals(a: BridgeId, b: BridgeId): boolean {
  return a.priority === b.priority
    && a.mac.toLowerCase() === b.mac.toLowerCase();
}

export function bridgeToString(b: BridgeId): string {
  return `${b.priority}/${b.mac}`;
}
