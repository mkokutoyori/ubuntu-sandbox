import type { NetworkPdu } from '@/network/core/NetworkPdu';
import type { IPv4Packet } from '@/network/core/types';
import type { LabelStackEntry } from './LabelStack';

export interface MplsPacket extends NetworkPdu {
  type: 'mpls';
  stack: readonly LabelStackEntry[];
  payload: IPv4Packet;
}

export function isMplsPacket(value: unknown): value is MplsPacket {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'mpls';
}
