import { lsaBodyBytes } from './checksum';
import type {
  LSA, LSAHeader, OSPFDDPacket, OSPFHelloPacket, OSPFLSAckPacket, OSPFLSRequestPacket, OSPFLSUpdatePacket, OSPFPacket,
} from './types';

const OSPF_VERSION_2 = 2;
const HEADER_BYTES = 24;
const LSA_HEADER_BYTES = 20;
const AUTH_NONE = 0;
const AUTH_SIMPLE = 1;
const AUTH_MD5 = 2;
const AUTH_DATA_BYTES = 8;
const MD5_DIGEST_BYTES = 16;
const CHECKSUM_OFFSET = 12;
const AUTH_OFFSET = 16;
const LSA_CHECKSUM_OFFSET = 14;
const FLETCHER_MODULUS = 255;

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
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

function fletcherChecksum(afterAge: readonly number[]): number {
  let c0 = 0;
  let c1 = 0;
  for (const byte of afterAge) {
    c0 = (c0 + byte) % FLETCHER_MODULUS;
    c1 = (c1 + c0) % FLETCHER_MODULUS;
  }
  const length = afterAge.length;
  const position = LSA_CHECKSUM_OFFSET + 1;
  let x = (((length - position) * c0 - c1) % FLETCHER_MODULUS + FLETCHER_MODULUS) % FLETCHER_MODULUS;
  let y = (((position - length - 1) * c0 + c1) % FLETCHER_MODULUS + FLETCHER_MODULUS) % FLETCHER_MODULUS;
  if (x === 0) x = FLETCHER_MODULUS;
  if (y === 0) y = FLETCHER_MODULUS;
  return (x << 8) | y;
}

function lsaHeaderBytes(header: LSAHeader, length: number, checksum: number): number[] {
  return [
    ...u16(header.lsAge), header.options & 0xff, header.lsType & 0xff, ...ipv4(header.linkStateId),
    ...ipv4(header.advertisingRouter), ...u32(header.lsSequenceNumber >>> 0), ...u16(checksum), ...u16(length),
  ];
}

export function ospfLsaBytes(lsa: LSA): number[] {
  const body = lsaBodyBytes(lsa);
  const length = LSA_HEADER_BYTES + body.length;
  const unchecked = lsaHeaderBytes(lsa, length, 0);
  const afterAge = [...unchecked.slice(2), ...body];
  const checksum = fletcherChecksum(afterAge);
  return [...lsaHeaderBytes(lsa, length, checksum), ...body];
}

function lsaHeaderOnlyBytes(header: LSAHeader): number[] {
  return lsaHeaderBytes(header, header.length || LSA_HEADER_BYTES, header.checksum & 0xffff);
}

function helloBody(hello: OSPFHelloPacket): number[] {
  return [
    ...ipv4(hello.networkMask), ...u16(hello.helloInterval), hello.options & 0xff, hello.priority & 0xff,
    ...u32(hello.deadInterval >>> 0), ...ipv4(hello.designatedRouter), ...ipv4(hello.backupDesignatedRouter),
    ...hello.neighbors.flatMap(ipv4),
  ];
}

function databaseDescriptionBody(dd: OSPFDDPacket): number[] {
  return [
    ...u16(dd.interfaceMTU), dd.options & 0xff, dd.flags & 0xff, ...u32(dd.ddSequenceNumber >>> 0),
    ...dd.lsaHeaders.flatMap(lsaHeaderOnlyBytes),
  ];
}

function requestBody(request: OSPFLSRequestPacket): number[] {
  return request.requests.flatMap((entry) => [...u32(entry.lsType), ...ipv4(entry.linkStateId), ...ipv4(entry.advertisingRouter)]);
}

function updateBody(update: OSPFLSUpdatePacket): number[] {
  return [...u32(update.lsas.length), ...update.lsas.flatMap(ospfLsaBytes)];
}

function acknowledgementBody(ack: OSPFLSAckPacket): number[] {
  return ack.lsaHeaders.flatMap(lsaHeaderOnlyBytes);
}

function bodyOf(packet: OSPFPacket): number[] {
  switch (packet.packetType) {
    case 1: return helloBody(packet);
    case 2: return databaseDescriptionBody(packet);
    case 3: return requestBody(packet);
    case 4: return updateBody(packet);
    case 5: return acknowledgementBody(packet);
  }
}

function authenticationBytes(packet: OSPFPacket): number[] {
  const authType = packet.authType ?? AUTH_NONE;
  if (authType === AUTH_SIMPLE) {
    const key = Array.from(new TextEncoder().encode(packet.authKey ?? '')).slice(0, AUTH_DATA_BYTES);
    while (key.length < AUTH_DATA_BYTES) key.push(0);
    return key;
  }
  if (authType === AUTH_MD5) return [0, 0, (packet.authKeyId ?? 0) & 0xff, MD5_DIGEST_BYTES, ...u32((packet.authSequence ?? 0) >>> 0)];
  return new Array<number>(AUTH_DATA_BYTES).fill(0);
}

function digestBytes(packet: OSPFPacket): number[] {
  const hex = packet.authDigest ?? '';
  const bytes: number[] = [];
  if (/^[0-9a-fA-F]{32}$/.test(hex)) for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  else bytes.push(...Array.from(new TextEncoder().encode(hex)).slice(0, MD5_DIGEST_BYTES));
  while (bytes.length < MD5_DIGEST_BYTES) bytes.push(0);
  return bytes;
}

export function ospfPacketBytes(packet: OSPFPacket): number[] | undefined {
  if (packet.version !== OSPF_VERSION_2) return undefined;
  const body = bodyOf(packet);
  const length = HEADER_BYTES + body.length;
  const authType = packet.authType ?? AUTH_NONE;
  const bytes = [
    OSPF_VERSION_2, packet.packetType, ...u16(length), ...ipv4(packet.routerId), ...ipv4(packet.areaId),
    0, 0, ...u16(authType), ...authenticationBytes(packet), ...body,
  ];
  if (authType !== AUTH_MD5) {
    const covered = [...bytes.slice(0, AUTH_OFFSET), ...bytes.slice(AUTH_OFFSET + AUTH_DATA_BYTES)];
    const checksum = internetChecksum(covered);
    bytes[CHECKSUM_OFFSET] = checksum >>> 8;
    bytes[CHECKSUM_OFFSET + 1] = checksum & 0xff;
  } else {
    bytes.push(...digestBytes(packet));
  }
  return bytes;
}

export function ospfWireLength(packet: OSPFPacket): number {
  return ospfPacketBytes(packet)?.length ?? 64;
}
