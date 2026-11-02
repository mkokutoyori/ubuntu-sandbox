import type { HsrpOpcode, HsrpPacket, HsrpState } from './types';

export const HSRP_MESSAGE_BYTES = 20;

const WIRE_VERSION_ONE = 0;
const AUTH_BYTES = 8;
const OPCODES: Readonly<Record<HsrpOpcode, number>> = { hello: 0, coup: 1, resign: 2 };
const STATES: Readonly<Record<HsrpState, number>> = { init: 0, learn: 1, listen: 2, speak: 4, standby: 8, active: 16 };

export function hsrpIsEncodable(packet: HsrpPacket): boolean {
  return packet.version === 1;
}

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function authenticationData(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text)).slice(0, AUTH_BYTES);
  while (bytes.length < AUTH_BYTES) bytes.push(0);
  return bytes;
}

export function hsrpPayloadBytes(packet: HsrpPacket): number[] {
  return [
    WIRE_VERSION_ONE, OPCODES[packet.opcode], STATES[packet.state], packet.helloSec & 0xff,
    packet.holdSec & 0xff, packet.priority & 0xff, packet.group & 0xff, 0,
    ...authenticationData(packet.authText),
    ...ipv4(packet.vip),
  ];
}
