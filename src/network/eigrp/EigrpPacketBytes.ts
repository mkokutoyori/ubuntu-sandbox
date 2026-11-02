import type { EigrpAuthTlv, EigrpExternalProtocol, EigrpHelloPacket, EigrpPacket, EigrpRouteTlv, EigrpStubTlv, EigrpUpdatePacket } from './packets';
import { EIGRP_BANDWIDTH_SCALE, EIGRP_METRIC_MULTIPLIER } from './metric';

const VERSION = 2;
const OPCODE_UPDATE = 1;
const OPCODE_HELLO = 5;
const FLAG_INIT = 0x01;
const HEADER_BYTES = 20;
const TLV_HEADER_BYTES = 4;
const TLV_PARAMETERS = 0x0001;
const TLV_AUTHENTICATION = 0x0002;
const TLV_SOFTWARE_VERSION = 0x0004;
const TLV_STUB = 0x0006;
const TLV_IP_INTERNAL = 0x0102;
const TLV_IP_EXTERNAL = 0x0103;
const AUTH_TYPE_MD5 = 2;
const AUTH_DIGEST_BYTES = 16;
const AUTH_PADDING_BYTES = 8;
const IOS_VERSION: readonly [number, number] = [12, 4];
const EIGRP_VERSION_PAIR: readonly [number, number] = [1, 2];
const ROUTE_MTU = 1500;
const ROUTE_RELIABILITY = 255;
const ROUTE_LOAD = 1;
const DELAY_UNIT_USEC = 10;
const CHECKSUM_OFFSET = 2;
const MAX_FIELD = 0xffffffff;
const STUB_CONNECTED = 0x0001;
const STUB_STATIC = 0x0002;
const STUB_SUMMARY = 0x0004;
const STUB_REDISTRIBUTED = 0x0008;
const STUB_RECEIVE_ONLY = 0x0020;

const EXTERNAL_PROTOCOL_IDS: Readonly<Record<EigrpExternalProtocol, number>> = {
  static: 0x03, rip: 0x04, ospf: 0x06, bgp: 0x09, connected: 0x0b,
};

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u24(value: number): number[] {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function ipv4(text: string): number[] {
  const parts = text.split('.').map((part) => parseInt(part, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function internetChecksum(bytes: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (i + 1 < bytes.length ? bytes[i + 1] : 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

function tlv(type: number, value: readonly number[]): number[] {
  return [...u16(type), ...u16(TLV_HEADER_BYTES + value.length), ...value];
}

function delayField(delayUsec: number): number {
  return Math.min(MAX_FIELD, Math.round(delayUsec / DELAY_UNIT_USEC) * EIGRP_METRIC_MULTIPLIER);
}

function bandwidthField(bandwidthKbps: number): number {
  return Math.min(MAX_FIELD, Math.floor(EIGRP_BANDWIDTH_SCALE / Math.max(1, bandwidthKbps)) * EIGRP_METRIC_MULTIPLIER);
}

function authentication(auth: EigrpAuthTlv): number[] {
  const digest = Array.from(new TextEncoder().encode(auth.digest)).slice(0, AUTH_DIGEST_BYTES);
  while (digest.length < AUTH_DIGEST_BYTES) digest.push(0);
  return tlv(TLV_AUTHENTICATION, [
    ...u16(AUTH_TYPE_MD5), ...u16(AUTH_DIGEST_BYTES), ...u32(auth.keyId), ...u32(0), ...new Array<number>(AUTH_PADDING_BYTES).fill(0), ...digest,
  ]);
}

function stub(flags: EigrpStubTlv): number[] {
  const bits = (flags.connected ? STUB_CONNECTED : 0) | (flags.staticRoutes ? STUB_STATIC : 0) | (flags.summary ? STUB_SUMMARY : 0)
    | (flags.redistributed ? STUB_REDISTRIBUTED : 0) | (flags.receiveOnly ? STUB_RECEIVE_ONLY : 0);
  return tlv(TLV_STUB, [...u16(bits), 0, 0]);
}

function helloTlvs(hello: EigrpHelloPacket): number[] {
  const k = hello.kValues;
  return [
    ...(hello.auth === undefined ? [] : authentication(hello.auth)),
    ...tlv(TLV_PARAMETERS, [k.k1, k.k2, k.k3, k.k4, k.k5, 0, ...u16(hello.holdTimeSec)]),
    ...tlv(TLV_SOFTWARE_VERSION, [...IOS_VERSION, ...EIGRP_VERSION_PAIR]),
    ...(hello.stub === undefined ? [] : stub(hello.stub)),
  ];
}

function destinationBytes(network: string, prefixLength: number): number[] {
  return ipv4(network).slice(0, Math.ceil(prefixLength / 8));
}

function routeVector(route: EigrpRouteTlv): number[] {
  return [
    ...u32(delayField(route.delayUsec)), ...u32(bandwidthField(route.bandwidthKbps)), ...u24(ROUTE_MTU),
    route.hopCount ?? 0, ROUTE_RELIABILITY, ROUTE_LOAD, 0, 0,
    route.prefixLength, ...destinationBytes(route.network, route.prefixLength),
  ];
}

function routeTlv(route: EigrpRouteTlv, asn: number): number[] {
  if (!route.external) return tlv(TLV_IP_INTERNAL, [...ipv4('0.0.0.0'), ...routeVector(route)]);
  return tlv(TLV_IP_EXTERNAL, [
    ...ipv4('0.0.0.0'), ...ipv4(route.originRouter ?? '0.0.0.0'), ...u32(asn), ...u32(0), ...u32(0), 0, 0,
    route.externalProtocol === undefined ? 0 : EXTERNAL_PROTOCOL_IDS[route.externalProtocol], 0,
    ...routeVector(route),
  ]);
}

function updateTlvs(update: EigrpUpdatePacket): number[] {
  return [
    ...(update.auth === undefined ? [] : authentication(update.auth)),
    ...update.routes.flatMap((route) => routeTlv(route, update.asn)),
  ];
}

export function eigrpPacketBytes(packet: EigrpPacket): number[] {
  const hello = packet.opcode === 'hello';
  const ackOnly = hello && packet.ackOnly === true;
  const flags = packet.opcode === 'update' && packet.init === true ? FLAG_INIT : 0;
  const sequence = packet.opcode === 'update' ? packet.sequence ?? 0 : 0;
  const acknowledge = packet.opcode === 'hello' ? packet.acknowledge ?? 0 : 0;
  const body = ackOnly ? [] : packet.opcode === 'hello' ? helloTlvs(packet) : updateTlvs(packet);
  const bytes = [
    VERSION, hello ? OPCODE_HELLO : OPCODE_UPDATE, 0, 0, ...u32(flags), ...u32(sequence), ...u32(acknowledge), ...u16(0), ...u16(packet.asn), ...body,
  ];
  const checksum = internetChecksum(bytes);
  bytes[CHECKSUM_OFFSET] = checksum >>> 8;
  bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  return bytes;
}

export function eigrpWireLength(packet: EigrpPacket): number {
  return Math.max(HEADER_BYTES, eigrpPacketBytes(packet).length);
}
