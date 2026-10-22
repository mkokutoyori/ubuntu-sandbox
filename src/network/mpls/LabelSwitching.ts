import { computeIPv4Checksum, type IPAddress, type IPv4Packet } from '@/network/core/types';
import { makeLabelStackEntry, withBottomOfStack, MAX_MPLS_TTL, type LabelStackEntry } from './LabelStack';
import { Lfib, type FtnEntry } from './Lfib';
import { carriesIp, type MplsPacket } from './MplsPacket';
import { MplsLabel } from './MplsLabel';
import type { PseudowirePayload } from '@/network/pw/PseudowirePacket';

export type DiffServModel = 'uniform' | 'pipe' | 'short-pipe';

export interface TtlPolicy {
  readonly propagateTtl: boolean;
  readonly entropyLabelCapable?: boolean;
  readonly diffServModel?: DiffServModel;
  readonly tunnelTrafficClass?: number;
  dscpToTrafficClass?(dscp: number): number;
  trafficClassToDscp?(trafficClass: number): number;
}

const DSCP_SHIFT = 2;
const ECN_MASK = 0x03;

export function dscpOf(packet: IPv4Packet): number {
  return packet.tos >> DSCP_SHIFT;
}

function withDscp(packet: IPv4Packet, dscp: number): IPv4Packet {
  const updated: IPv4Packet = { ...packet, tos: (dscp << DSCP_SHIFT) | (packet.tos & ECN_MASK), headerChecksum: 0 };
  updated.headerChecksum = computeIPv4Checksum(updated);
  return updated;
}

export function impositionTrafficClass(packet: IPv4Packet, policy: TtlPolicy): number {
  if ((policy.diffServModel ?? 'pipe') === 'uniform') return policy.dscpToTrafficClass?.(dscpOf(packet)) ?? 0;
  return policy.tunnelTrafficClass ?? 0;
}

export type SwitchingDecision =
  | { readonly kind: 'no-binding'; readonly packet: MplsPacket }
  | { readonly kind: 'expired'; readonly packet: MplsPacket }
  | { readonly kind: 'labelled'; readonly packet: MplsPacket; readonly iface: string; readonly nextHop: IPAddress }
  | { readonly kind: 'unlabelled'; readonly packet: IPv4Packet; readonly iface: string; readonly nextHop: IPAddress }
  | { readonly kind: 'deliver'; readonly packet: IPv4Packet; readonly ttlAccounted: boolean }
  | { readonly kind: 'deliver-vrf'; readonly packet: IPv4Packet; readonly vrf: string; readonly ttlAccounted: boolean }
  | { readonly kind: 'deliver-pw'; readonly payload: PseudowirePayload; readonly owner: 'xconnect' | 'vpls'; readonly endpoint: string };

function withIpTtl(packet: IPv4Packet, ttl: number): IPv4Packet {
  const updated: IPv4Packet = { ...packet, ttl, headerChecksum: 0 };
  updated.headerChecksum = computeIPv4Checksum(updated);
  return updated;
}

function outgoingTtl(incoming: number): number {
  return Math.max(incoming - 1, 0);
}

function exposed(
  packet: MplsPacket, remaining: readonly LabelStackEntry[], ttl: number, policy: TtlPolicy, poppedClass: number,
): MplsPacket | IPv4Packet | null {
  const uniform = (policy.diffServModel ?? 'pipe') === 'uniform';
  if (remaining.length === 0) {
    if (!carriesIp(packet)) return null;
    const ip = uniform ? withDscp(packet.payload, policy.trafficClassToDscp?.(poppedClass) ?? 0) : packet.payload;
    return policy.propagateTtl ? withIpTtl(ip, ttl) : ip;
  }
  const [top, ...rest] = remaining;
  const retained = { ...top, ...(policy.propagateTtl ? { ttl } : {}), ...(uniform ? { trafficClass: poppedClass } : {}) };
  return { ...packet, stack: withBottomOfStack([retained, ...rest]) };
}

export function imposeLabels(packet: IPv4Packet, entry: FtnEntry, policy: TtlPolicy, entropyLabel?: MplsLabel): MplsPacket {
  const ttl = policy.propagateTtl ? packet.ttl : MAX_MPLS_TTL;
  const trafficClass = impositionTrafficClass(packet, policy);
  const entries = entry.outLabels.map(label => makeLabelStackEntry(label, ttl, trafficClass));
  if (entropyLabel !== undefined) {
    entries.push(makeLabelStackEntry(MplsLabel.ENTROPY_LABEL_INDICATOR, ttl, trafficClass), makeLabelStackEntry(entropyLabel, 0, trafficClass));
  }
  return { type: 'mpls', stack: withBottomOfStack(entries), payload: packet };
}

function continueAfterPop(
  packet: MplsPacket, remaining: readonly LabelStackEntry[], ttl: number, lfib: Lfib, policy: TtlPolicy,
): SwitchingDecision {
  if (remaining.length === 0) {
    const ip = exposed({ ...packet, stack: [] }, [], ttl, policy, packet.stack[0].trafficClass);
    if (ip !== null && ip.type === 'ipv4') return { kind: 'deliver', packet: ip, ttlAccounted: policy.propagateTtl };
    return { kind: 'no-binding', packet };
  }
  const [next, ...deeper] = remaining;
  const uniform = (policy.diffServModel ?? 'pipe') === 'uniform';
  const carried = {
    ...next, ...(policy.propagateTtl ? { ttl: Math.min(next.ttl, ttl + 1) } : {}),
    ...(uniform ? { trafficClass: packet.stack[0].trafficClass } : {}),
  };
  return switchLabelled({ ...packet, stack: withBottomOfStack([carried, ...deeper]) }, lfib, policy);
}

export function switchLabelled(packet: MplsPacket, lfib: Lfib, policy: TtlPolicy): SwitchingDecision {
  const [top, ...below] = packet.stack;
  const ttl = outgoingTtl(top.ttl);
  if (ttl === 0) return { kind: 'expired', packet };

  if (top.label.isExplicitNull()) return continueAfterPop(packet, below, ttl, lfib, policy);

  if (top.label.equals(MplsLabel.ENTROPY_LABEL_INDICATOR)) {
    if (!policy.entropyLabelCapable || top.bottom || below.length === 0) return { kind: 'no-binding', packet };
    return continueAfterPop(packet, below.slice(1), ttl, lfib, policy);
  }

  const entry = lfib.lookupIlm(top.label);
  if (entry === undefined) return { kind: 'no-binding', packet };

  if (entry.kind === 'pw') {
    if (below.length > 0 || packet.payload.type !== 'pw-ethernet') return { kind: 'no-binding', packet };
    return { kind: 'deliver-pw', payload: packet.payload, owner: entry.owner, endpoint: entry.endpoint };
  }

  if (entry.kind === 'vrf') {
    const result = exposed(packet, below, ttl, policy, top.trafficClass);
    if (result === null || result.type !== 'ipv4') return { kind: 'no-binding', packet };
    return { kind: 'deliver-vrf', packet: result, vrf: entry.vrf, ttlAccounted: policy.propagateTtl };
  }

  if (entry.kind === 'pop') {
    if (entry.iface === null && below.length > 0) return continueAfterPop(packet, below, ttl, lfib, policy);
    const result = exposed(packet, below, ttl, policy, top.trafficClass);
    if (result === null) return { kind: 'no-binding', packet };
    if (result.type === 'ipv4') {
      if (entry.iface === null || entry.nextHop === null) {
        return { kind: 'deliver', packet: result, ttlAccounted: policy.propagateTtl };
      }
      return { kind: 'unlabelled', packet: result, iface: entry.iface, nextHop: entry.nextHop };
    }
    if (entry.iface === null || entry.nextHop === null) return { kind: 'no-binding', packet };
    return { kind: 'labelled', packet: result, iface: entry.iface, nextHop: entry.nextHop };
  }

  const innermost = entry.outLabels.length - 1;
  const replacement = entry.outLabels.map((label, index) => makeLabelStackEntry(
    label, index === innermost || policy.propagateTtl ? ttl : MAX_MPLS_TTL, top.trafficClass));
  const stack = withBottomOfStack([...replacement, ...below]);
  return { kind: 'labelled', packet: { ...packet, stack }, iface: entry.iface, nextHop: entry.nextHop };
}
