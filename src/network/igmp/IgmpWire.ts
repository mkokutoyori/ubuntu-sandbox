import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import type { IgmpMessageType, IgmpPacket } from './types';

export const IGMP_MESSAGE_BYTES = 8;

const MESSAGE_CODES: Readonly<Record<IgmpMessageType, number>> = {
  'membership-query': 0x11,
  'v1-membership-report': 0x12,
  'v2-membership-report': 0x16,
  'leave-group': 0x17,
};
const MAX_RESPONSE_CODE = 0xff;
const CHECKSUM_OFFSET = 2;

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

export function igmpPayloadBytes(packet: IgmpPacket): number[] {
  const response = packet.messageType === 'membership-query' ? Math.min(packet.maxRespTimeDs, MAX_RESPONSE_CODE) : 0;
  const bytes = [MESSAGE_CODES[packet.messageType], response, 0, 0, ...ipv4(packet.groupAddress)];
  const checksum = internetChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = checksum >>> 8;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  return bytes;
}
