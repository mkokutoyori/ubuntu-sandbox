import { encodeVarint, decodeVarint } from './varint';
import {
  hexToBytes, bytesToHex,
  type QuicPacket, type QuicLongHeaderPacket, type QuicShortHeaderPacket, type QuicVersionNegotiationPacket,
  type QuicLongPacketType,
} from './types';

const LONG_TYPE_TO_BITS: Record<QuicLongPacketType, number> = { initial: 0x0, '0-rtt': 0x1, handshake: 0x2, retry: 0x3 };
const BITS_TO_LONG_TYPE: Record<number, QuicLongPacketType> = Object.fromEntries(
  Object.entries(LONG_TYPE_TO_BITS).map(([k, v]) => [v, k as QuicLongPacketType]),
);

function pushVersion(parts: number[], version: number): void {
  parts.push((version >>> 24) & 0xff, (version >>> 16) & 0xff, (version >>> 8) & 0xff, version & 0xff);
}

function readVersion(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

// RFC 9000 §17.1 — packet numbers are truncated big-endian, length chosen to fit the value (not varint-encoded).
export function determinePacketNumberLength(packetNumber: number): 1 | 2 | 3 | 4 {
  if (packetNumber < 0x100) return 1;
  if (packetNumber < 0x10000) return 2;
  if (packetNumber < 0x1000000) return 3;
  return 4;
}

function encodePacketNumber(pn: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = pn;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

function decodePacketNumber(bytes: Uint8Array, offset: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + bytes[offset + i];
  return v;
}

// RFC 9000 §17.2 — long header packet (Initial, 0-RTT, Handshake, Retry).
export function encodeLongHeader(packet: QuicLongHeaderPacket): Uint8Array {
  const typeBits = LONG_TYPE_TO_BITS[packet.type];
  const dcidBytes = hexToBytes(packet.destConnectionId);
  const scidBytes = hexToBytes(packet.srcConnectionId);
  const parts: number[] = [];

  if (packet.type === 'retry') {
    parts.push(0xc0 | (typeBits << 4));
    pushVersion(parts, packet.version);
    parts.push(dcidBytes.length, ...dcidBytes);
    parts.push(scidBytes.length, ...scidBytes);
    parts.push(...(packet.token ?? new Uint8Array(0)));
    return new Uint8Array(parts);
  }

  const pn = packet.packetNumber ?? 0;
  const pnLength = determinePacketNumberLength(pn);
  parts.push(0xc0 | (typeBits << 4) | (pnLength - 1));
  pushVersion(parts, packet.version);
  parts.push(dcidBytes.length, ...dcidBytes);
  parts.push(scidBytes.length, ...scidBytes);

  if (packet.type === 'initial') {
    const token = packet.token ?? new Uint8Array(0);
    parts.push(...encodeVarint(token.length), ...token);
  }

  const pnBytes = encodePacketNumber(pn, pnLength);
  parts.push(...encodeVarint(pnBytes.length + packet.payload.length));
  parts.push(...pnBytes);
  parts.push(...packet.payload);
  return new Uint8Array(parts);
}

export interface DecodedPacket<T extends QuicPacket = QuicPacket> {
  packet: T;
  bytesConsumed: number;
}

export function decodeLongHeader(bytes: Uint8Array, offset = 0): DecodedPacket<QuicLongHeaderPacket> | null {
  if (bytes.length < offset + 1 || (bytes[offset] & 0x80) === 0) return null;
  const byte0 = bytes[offset];
  let off = offset + 1;

  if (bytes.length < off + 4) return null;
  const version = readVersion(bytes, off);
  off += 4;

  if (bytes.length < off + 1) return null;
  const dcidLen = bytes[off];
  off += 1;
  if (bytes.length < off + dcidLen) return null;
  const destConnectionId = bytesToHex(bytes.slice(off, off + dcidLen));
  off += dcidLen;

  if (bytes.length < off + 1) return null;
  const scidLen = bytes[off];
  off += 1;
  if (bytes.length < off + scidLen) return null;
  const srcConnectionId = bytesToHex(bytes.slice(off, off + scidLen));
  off += scidLen;

  const type = BITS_TO_LONG_TYPE[(byte0 >> 4) & 0x3];
  if (type === undefined) return null;

  if (type === 'retry') {
    const token = bytes.slice(off);
    return {
      packet: { form: 'long', type, version, destConnectionId, srcConnectionId, token, payload: new Uint8Array(0) },
      bytesConsumed: bytes.length - offset,
    };
  }

  let token: Uint8Array | undefined;
  if (type === 'initial') {
    const tokenLen = decodeVarint(bytes, off);
    if (!tokenLen) return null;
    off += tokenLen.bytesConsumed;
    if (bytes.length < off + tokenLen.value) return null;
    token = bytes.slice(off, off + tokenLen.value);
    off += tokenLen.value;
  }

  const lengthField = decodeVarint(bytes, off);
  if (!lengthField) return null;
  off += lengthField.bytesConsumed;

  const pnLength = (byte0 & 0x3) + 1;
  if (bytes.length < off + pnLength) return null;
  const packetNumber = decodePacketNumber(bytes, off, pnLength);
  off += pnLength;

  const payloadLength = lengthField.value - pnLength;
  if (payloadLength < 0 || bytes.length < off + payloadLength) return null;
  const payload = bytes.slice(off, off + payloadLength);
  off += payloadLength;

  return {
    packet: { form: 'long', type, version, destConnectionId, srcConnectionId, token, packetNumber, payload },
    bytesConsumed: off - offset,
  };
}

// RFC 9000 §17.3 — short header (1-RTT). The DCID has no on-wire length
// prefix; the caller must know its length from connection state.
export function encodeShortHeader(packet: QuicShortHeaderPacket): Uint8Array {
  const pnLength = determinePacketNumberLength(packet.packetNumber);
  const dcidBytes = hexToBytes(packet.destConnectionId);
  const pnBytes = encodePacketNumber(packet.packetNumber, pnLength);
  const out = new Uint8Array(1 + dcidBytes.length + pnBytes.length + packet.payload.length);
  out[0] = 0x40 | (pnLength - 1);
  out.set(dcidBytes, 1);
  out.set(pnBytes, 1 + dcidBytes.length);
  out.set(packet.payload, 1 + dcidBytes.length + pnBytes.length);
  return out;
}

export function decodeShortHeader(bytes: Uint8Array, dcidLength: number, offset = 0): DecodedPacket<QuicShortHeaderPacket> | null {
  if (bytes.length < offset + 1 || (bytes[offset] & 0x80) !== 0) return null;
  const byte0 = bytes[offset];
  let off = offset + 1;

  if (bytes.length < off + dcidLength) return null;
  const destConnectionId = bytesToHex(bytes.slice(off, off + dcidLength));
  off += dcidLength;

  const pnLength = (byte0 & 0x3) + 1;
  if (bytes.length < off + pnLength) return null;
  const packetNumber = decodePacketNumber(bytes, off, pnLength);
  off += pnLength;

  const payload = bytes.slice(off);
  return { packet: { form: 'short', destConnectionId, packetNumber, payload }, bytesConsumed: bytes.length - offset };
}

// RFC 9000 §17.2.1 — Version Negotiation: Version field is 0, followed by a list of 4-byte supported versions.
export function encodeVersionNegotiation(packet: QuicVersionNegotiationPacket): Uint8Array {
  const dcidBytes = hexToBytes(packet.destConnectionId);
  const scidBytes = hexToBytes(packet.srcConnectionId);
  const parts: number[] = [0x80, 0, 0, 0, 0];
  parts.push(dcidBytes.length, ...dcidBytes);
  parts.push(scidBytes.length, ...scidBytes);
  for (const v of packet.supportedVersions) pushVersion(parts, v);
  return new Uint8Array(parts);
}

export function decodeVersionNegotiation(bytes: Uint8Array, offset = 0): DecodedPacket<QuicVersionNegotiationPacket> | null {
  if (bytes.length < offset + 5 || (bytes[offset] & 0x80) === 0) return null;
  if (readVersion(bytes, offset + 1) !== 0) return null;
  let off = offset + 5;

  if (bytes.length < off + 1) return null;
  const dcidLen = bytes[off];
  off += 1;
  if (bytes.length < off + dcidLen) return null;
  const destConnectionId = bytesToHex(bytes.slice(off, off + dcidLen));
  off += dcidLen;

  if (bytes.length < off + 1) return null;
  const scidLen = bytes[off];
  off += 1;
  if (bytes.length < off + scidLen) return null;
  const srcConnectionId = bytesToHex(bytes.slice(off, off + scidLen));
  off += scidLen;

  const supportedVersions: number[] = [];
  while (off + 4 <= bytes.length) {
    supportedVersions.push(readVersion(bytes, off));
    off += 4;
  }

  return { packet: { form: 'version-negotiation', destConnectionId, srcConnectionId, supportedVersions }, bytesConsumed: off - offset };
}

export interface DecodePacketOptions {
  /** Required to decode a short-header packet — the DCID length is implicit on the wire, known from connection state. */
  shortHeaderDcidLength?: number;
}

export function decodePacket(bytes: Uint8Array, opts: DecodePacketOptions = {}, offset = 0): DecodedPacket | null {
  if (bytes.length < offset + 1) return null;
  const isLong = (bytes[offset] & 0x80) !== 0;
  if (!isLong) {
    if (opts.shortHeaderDcidLength === undefined) return null;
    return decodeShortHeader(bytes, opts.shortHeaderDcidLength, offset);
  }
  if (bytes.length < offset + 5) return null;
  if (readVersion(bytes, offset + 1) === 0) return decodeVersionNegotiation(bytes, offset);
  return decodeLongHeader(bytes, offset);
}
