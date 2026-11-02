import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import type { VrrpPacket } from './types';

const ADVERTISEMENT = 1;
const VERSION_SHIFT = 4;
const HEADER_BYTES = 8;
const AUTH_DATA_BYTES = 8;
const CHECKSUM_OFFSET = 6;

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function authenticationData(text: string | undefined): number[] {
  const bytes = Array.from(new TextEncoder().encode(text ?? '')).slice(0, AUTH_DATA_BYTES);
  while (bytes.length < AUTH_DATA_BYTES) bytes.push(0);
  return bytes;
}

export function vrrpWireLength(packet: VrrpPacket): number {
  return HEADER_BYTES + 4 * packet.vips.length + AUTH_DATA_BYTES;
}

export function vrrpPayloadBytes(packet: VrrpPacket): number[] {
  const bytes = [
    (packet.version << VERSION_SHIFT) | ADVERTISEMENT, packet.vrid, packet.priority, packet.vips.length,
    packet.authType ?? 0, packet.advertiseSec, 0, 0,
    ...packet.vips.flatMap(ipv4),
    ...authenticationData(packet.authData),
  ];
  const checksum = internetChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = checksum >>> 8;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  return bytes;
}
