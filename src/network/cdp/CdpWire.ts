import type { CdpCapability, CdpFrame } from './types';

const CDP_VERSION_TWO = 2;
const TLV_HEADER_BYTES = 4;
const TLV_DEVICE_ID = 0x0001;
const TLV_ADDRESSES = 0x0002;
const TLV_PORT_ID = 0x0003;
const TLV_CAPABILITIES = 0x0004;
const TLV_VERSION = 0x0005;
const TLV_PLATFORM = 0x0006;
const TLV_VTP_DOMAIN = 0x0009;
const TLV_NATIVE_VLAN = 0x000a;
const TLV_DUPLEX = 0x000b;
const NLPID_PROTOCOL_TYPE = 1;
const NLPID_IP = 0xcc;
const IPV4_BYTES = 4;

const CAPABILITY_BITS: Readonly<Record<CdpCapability, number>> = {
  Router: 0x01, Switch: 0x08, Host: 0x10, IGMP: 0x20, Repeater: 0x40,
};

export const CDP_SNAP_HEADER: readonly number[] = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x20, 0x00];

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

function ipv4(address: string): number[] {
  const parts = address.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < IPV4_BYTES) parts.push(0);
  return parts.slice(0, IPV4_BYTES);
}

function cdpChecksum(bytes: readonly number[]): number {
  let sum = 0;
  const even = bytes.length - (bytes.length % 2);
  for (let i = 0; i < even; i += 2) sum += (bytes[i] << 8) | bytes[i + 1];
  if (bytes.length % 2 === 1) sum += bytes[bytes.length - 1];
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

export function cdpPayloadBytes(frame: CdpFrame): number[] {
  const body: number[] = [
    ...tlv(TLV_DEVICE_ID, text(frame.deviceId)),
    ...tlv(TLV_ADDRESSES, [
      ...u32(frame.addresses.length),
      ...frame.addresses.flatMap((address) => [NLPID_PROTOCOL_TYPE, 1, NLPID_IP, ...u16(IPV4_BYTES), ...ipv4(address)]),
    ]),
    ...tlv(TLV_PORT_ID, text(frame.portId)),
    ...tlv(TLV_CAPABILITIES, u32(frame.capabilities.reduce((bits, capability) => bits | CAPABILITY_BITS[capability], 0))),
    ...tlv(TLV_VERSION, text(frame.softwareVersion)),
    ...tlv(TLV_PLATFORM, text(frame.platform)),
  ];
  if (frame.vtpDomain !== undefined) body.push(...tlv(TLV_VTP_DOMAIN, text(frame.vtpDomain)));
  if (frame.nativeVlan !== undefined) body.push(...tlv(TLV_NATIVE_VLAN, u16(frame.nativeVlan)));
  if (frame.duplex !== 'auto') body.push(...tlv(TLV_DUPLEX, [frame.duplex === 'full' ? 1 : 0]));
  const unchecked = [CDP_VERSION_TWO, frame.holdtimeSec & 0xff, 0, 0, ...body];
  const checksum = cdpChecksum(unchecked);
  unchecked[2] = checksum >>> 8;
  unchecked[3] = checksum & 0xff;
  return unchecked;
}
