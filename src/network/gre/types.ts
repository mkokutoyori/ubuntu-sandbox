import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const IP_PROTO_GRE = 47;

export const GRE_PROTOCOL_IPV4 = 0x0800;
export const GRE_PROTOCOL_IPV6 = 0x86dd;
export const GRE_PROTOCOL_MPLS = 0x8847;
export const GRE_PROTOCOL_ARP = 0x0806;

export interface GrePacket extends NetworkPdu {
  type: 'gre';
  checksumPresent: boolean;
  keyPresent: boolean;
  sequencePresent: boolean;
  version: number;
  protocolType: number;
  checksum: number;
  key: number | null;
  sequence: number | null;
  payload: unknown;
}

export interface GreTunnel {
  tunnelId: string;
  sourceIp: string;
  destinationIp: string;
  overlayIp: string | null;
  overlayMask: string | null;
  key: number | null;
  ttl: number;
  enabled: boolean;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  sequenceEnabled: boolean;
  sendSeq: number;
  expectedRecvSeq: number;
  outOfOrderDrops: number;
  checksumEnabled: boolean;
  checksumDrops: number;
}

export interface GreConfig {
  enabled: boolean;
  tunnels: Map<string, GreTunnel>;
}

export function createDefaultGreConfig(): GreConfig {
  return { enabled: true, tunnels: new Map() };
}

export function defaultTunnel(tunnelId: string, sourceIp: string, destinationIp: string): GreTunnel {
  return {
    tunnelId, sourceIp, destinationIp,
    overlayIp: null, overlayMask: null,
    key: null, ttl: 255, enabled: true,
    bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0,
    sequenceEnabled: false, sendSeq: 0, expectedRecvSeq: 0, outOfOrderDrops: 0,
    checksumEnabled: false, checksumDrops: 0,
  };
}

export function computeGreChecksum(gre: { protocolType: number; key: number | null; sequence: number | null; payload: unknown }): number {
  const seed = JSON.stringify({
    p: gre.protocolType,
    k: gre.key,
    s: gre.sequence,
    body: gre.payload,
  });
  let sum = 0;
  for (let i = 0; i < seed.length; i++) {
    sum = (sum + seed.charCodeAt(i)) & 0xffff;
    sum = (((sum >> 8) | (sum << 8)) & 0xffff) ^ 0xa5a5;
  }
  return (~sum) & 0xffff;
}

export function matchTunnel(tunnels: Iterable<GreTunnel>, srcIp: string, dstIp: string, key: number | null): GreTunnel | null {
  for (const t of tunnels) {
    if (!t.enabled) continue;
    if (t.sourceIp !== dstIp) continue;
    if (t.destinationIp !== srcIp) continue;
    if (t.key !== key) continue;
    return t;
  }
  return null;
}
