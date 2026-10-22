import type { NetworkPdu } from '@/network/core/NetworkPdu';
import type { IPv4Packet } from '@/network/core/types';
import type { PseudowirePayload } from '@/network/pw/PseudowirePacket';
import type { LabelStackEntry } from './LabelStack';

export interface MplsPacket extends NetworkPdu {
  type: 'mpls';
  stack: readonly LabelStackEntry[];
  payload: IPv4Packet | PseudowirePayload;
}

export function carriesIp(packet: MplsPacket): packet is MplsPacket & { payload: IPv4Packet } {
  return packet.payload.type === 'ipv4';
}

export function isMplsPacket(value: unknown): value is MplsPacket {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'mpls';
}
