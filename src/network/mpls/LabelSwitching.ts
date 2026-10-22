import { computeIPv4Checksum, type IPAddress, type IPv4Packet } from '@/network/core/types';
import { makeLabelStackEntry, withBottomOfStack, MAX_MPLS_TTL, type LabelStackEntry } from './LabelStack';
import { Lfib, type FtnEntry } from './Lfib';
import type { MplsPacket } from './MplsPacket';

export interface TtlPolicy {
  readonly propagateTtl: boolean;
}

export type SwitchingDecision =
  | { readonly kind: 'no-binding'; readonly packet: MplsPacket }
  | { readonly kind: 'expired'; readonly packet: MplsPacket }
  | { readonly kind: 'labelled'; readonly packet: MplsPacket; readonly iface: string; readonly nextHop: IPAddress }
  | { readonly kind: 'unlabelled'; readonly packet: IPv4Packet; readonly iface: string; readonly nextHop: IPAddress }
  | { readonly kind: 'deliver'; readonly packet: IPv4Packet; readonly ttlAccounted: boolean };

function withIpTtl(packet: IPv4Packet, ttl: number): IPv4Packet {
  const updated: IPv4Packet = { ...packet, ttl, headerChecksum: 0 };
  updated.headerChecksum = computeIPv4Checksum(updated);
  return updated;
}

function outgoingTtl(incoming: number): number {
  return Math.max(incoming - 1, 0);
}

function exposed(packet: MplsPacket, remaining: readonly LabelStackEntry[], ttl: number, policy: TtlPolicy): MplsPacket | IPv4Packet {
  if (remaining.length === 0) return policy.propagateTtl ? withIpTtl(packet.payload, ttl) : packet.payload;
  const [top, ...rest] = remaining;
  const retained = policy.propagateTtl ? { ...top, ttl } : top;
  return { ...packet, stack: withBottomOfStack([retained, ...rest]) };
}

export function imposeLabels(packet: IPv4Packet, entry: FtnEntry, policy: TtlPolicy): MplsPacket {
  const ttl = policy.propagateTtl ? packet.ttl : MAX_MPLS_TTL;
  const stack = withBottomOfStack(entry.outLabels.map(label => makeLabelStackEntry(label, ttl)));
  return { type: 'mpls', stack, payload: packet };
}

export function switchLabelled(packet: MplsPacket, lfib: Lfib, policy: TtlPolicy): SwitchingDecision {
  const [top, ...below] = packet.stack;
  const ttl = outgoingTtl(top.ttl);
  if (ttl === 0) return { kind: 'expired', packet };

  if (top.label.isExplicitNull()) {
    const ip = exposed(packet, below, ttl, policy);
    if (ip.type === 'ipv4') return { kind: 'deliver', packet: ip, ttlAccounted: policy.propagateTtl };
    return { kind: 'no-binding', packet };
  }

  const entry = lfib.lookupIlm(top.label);
  if (entry === undefined) return { kind: 'no-binding', packet };

  if (entry.kind === 'pop') {
    const result = exposed(packet, below, ttl, policy);
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
