import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import type { UdldEchoEntry, UdldOpcode, UdldPacket } from './types';

const VERSION_SHIFT = 5;
const OPCODES: Readonly<Record<UdldOpcode, number>> = { probe: 1, echo: 2, flush: 3 };
const FLAG_RECOMMENDED_TIMEOUT = 0x01;
const TLV_HEADER_BYTES = 4;
const CHECKSUM_OFFSET = 2;
const TLV_DEVICE_ID = 0x0001;
const TLV_PORT_ID = 0x0002;
const TLV_ECHO = 0x0003;
const TLV_MESSAGE_INTERVAL = 0x0004;
const TLV_TIMEOUT_INTERVAL = 0x0005;
const TLV_DEVICE_NAME = 0x0006;
const TLV_SEQUENCE = 0x0007;

export const UDLD_SNAP_HEADER: readonly number[] = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x01, 0x11];

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function text(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function tlv(type: number, value: readonly number[]): number[] {
  return [...u16(type), ...u16(TLV_HEADER_BYTES + value.length), ...value];
}

function echoNeighbor(entry: UdldEchoEntry): number[] {
  const device = text(entry.deviceId);
  const port = text(entry.portId);
  return [...u16(device.length), ...device, ...u16(port.length), ...port];
}

export function udldPayloadBytes(packet: UdldPacket): number[] {
  const bytes = [
    (packet.version << VERSION_SHIFT) | OPCODES[packet.opcode],
    packet.opcode === 'probe' ? FLAG_RECOMMENDED_TIMEOUT : 0,
    0, 0,
    ...tlv(TLV_DEVICE_ID, text(packet.senderDeviceId)),
    ...tlv(TLV_PORT_ID, text(packet.senderPortId)),
    ...tlv(TLV_ECHO, [...u32(packet.echo.length), ...packet.echo.flatMap(echoNeighbor)]),
    ...tlv(TLV_MESSAGE_INTERVAL, [packet.messageInterval & 0xff]),
    ...tlv(TLV_TIMEOUT_INTERVAL, [packet.timeoutInterval & 0xff]),
    ...tlv(TLV_DEVICE_NAME, text(packet.senderHostname)),
    ...tlv(TLV_SEQUENCE, u32(packet.sequence)),
  ];
  const checksum = internetChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = checksum >>> 8;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  return bytes;
}
