/**
 * RADIUS wire codec (RFC 2865 §3) — pure encode/decode, no crypto and no
 * transport side effects. Authenticator computation/verification lives in
 * `authenticators.ts`; this module only turns a `RadiusPacket` into the
 * exact bytes a real NAS/server would put on the wire, and back.
 */
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import {
  RADIUS_CODE, RADIUS_ATTR,
  type RadiusCode, type RadiusAttribute, type RadiusPacket,
} from './types';
import {
  RADIUS_DICTIONARY, RADIUS_DICTIONARY_BY_TYPE, lookupVsa,
  type RadiusValueType,
} from './dictionary';

export interface RadiusDecodeError { error: string }

export function isRadiusDecodeError(x: unknown): x is RadiusDecodeError {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && 'error' in x;
}

const CODE_BY_NUMBER: ReadonlyMap<number, RadiusCode> = new Map(
  (Object.keys(RADIUS_CODE) as RadiusCode[]).map((name) => [RADIUS_CODE[name], name]),
);

const VSA_ATTR_TYPE = RADIUS_ATTR['vendor-specific'];

// ─── Encode ──────────────────────────────────────────────────────────

/**
 * Serialise a `RadiusPacket` to wire bytes. The Authenticator field is
 * copied verbatim (as raw bytes) from `packet.authenticator` — computing a
 * conformant Request/Response Authenticator is the caller's job.
 */
export function encodeRadiusPacket(packet: RadiusPacket): Uint8Array {
  const code = RADIUS_CODE[packet.code];
  if (code === undefined) throw new Error(`encodeRadiusPacket: unknown code "${packet.code}"`);
  const authBytes = hexToBytes(packet.authenticator);
  if (authBytes.length !== 16) {
    throw new Error(`encodeRadiusPacket: authenticator must be 16 bytes, got ${authBytes.length}`);
  }
  const attrBytes = concatBytes(packet.attributes.map(encodeAttribute));
  const totalLength = 20 + attrBytes.length;
  if (totalLength > 4096) {
    throw new Error(`encodeRadiusPacket: packet too large (${totalLength} bytes, RFC 2865 max is 4096)`);
  }
  const buf = new Uint8Array(totalLength);
  buf[0] = code;
  buf[1] = packet.identifier & 0xff;
  buf[2] = (totalLength >> 8) & 0xff;
  buf[3] = totalLength & 0xff;
  buf.set(authBytes, 4);
  buf.set(attrBytes, 20);
  return buf;
}

function encodeAttribute(a: RadiusAttribute): Uint8Array {
  if (a.type === 'vendor-specific' && a.vendor) return encodeVsaAttribute(a.vendor, a.value);
  const def = RADIUS_DICTIONARY[a.type];
  if (!def) throw new Error(`encodeRadiusPacket: unknown attribute "${a.type}"`);
  return tlv(def.type, encodeValue(def.valueType, a.value));
}

function encodeVsaAttribute(vendor: { id: number; type: number }, value: string | number): Uint8Array {
  const vsaDef = lookupVsa(vendor.id, vendor.type);
  const valueBytes = encodeValue(vsaDef?.valueType ?? 'octets', value);
  const subLength = valueBytes.length + 2; // Vendor-Type(1) + Vendor-Length(1) + Value
  if (subLength > 253) {
    throw new Error(`encodeRadiusPacket: VSA ${vendor.id}:${vendor.type} value too long (${valueBytes.length} bytes)`);
  }
  const block = new Uint8Array(4 + subLength);
  block[0] = (vendor.id >>> 24) & 0xff;
  block[1] = (vendor.id >>> 16) & 0xff;
  block[2] = (vendor.id >>> 8) & 0xff;
  block[3] = vendor.id & 0xff;
  block[4] = vendor.type & 0xff;
  block[5] = subLength & 0xff;
  block.set(valueBytes, 6);
  return tlv(VSA_ATTR_TYPE, block);
}

function tlv(type: number, value: Uint8Array): Uint8Array {
  const length = value.length + 2;
  if (length > 255) {
    throw new Error(
      `encodeRadiusPacket: attribute ${type} value too long (${value.length} bytes) — ` +
      `fragmentation across repeated attributes isn't implemented`,
    );
  }
  const out = new Uint8Array(length);
  out[0] = type;
  out[1] = length;
  out.set(value, 2);
  return out;
}

function encodeValue(valueType: RadiusValueType, value: string | number): Uint8Array {
  switch (valueType) {
    case 'text':
    case 'string':
      return utf8ToBytes(String(value));
    case 'address':
      return ipToBytes(String(value));
    case 'integer':
    case 'time':
      return uint32ToBytes(Number(value));
    case 'octets':
      return hexToBytes(String(value));
    case 'tagged-integer': {
      const n = Number(value) >>> 0;
      return Uint8Array.of(0x00, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    }
    case 'tagged-string': {
      const strBytes = utf8ToBytes(String(value));
      const out = new Uint8Array(strBytes.length + 1);
      out[0] = 0x00;
      out.set(strBytes, 1);
      return out;
    }
  }
}

// ─── Decode ──────────────────────────────────────────────────────────

/**
 * Parse wire bytes into a `RadiusPacket`. Attributes whose type isn't in
 * the dictionary are skipped (not errored) — real RADIUS implementations
 * silently ignore attributes they don't recognise rather than rejecting
 * the whole packet.
 */
export function decodeRadiusPacket(bytes: Uint8Array): RadiusPacket | RadiusDecodeError {
  if (bytes.length < 20) return { error: `packet too short (${bytes.length} bytes, minimum 20)` };
  const codeNum = bytes[0];
  const code = CODE_BY_NUMBER.get(codeNum);
  if (!code) return { error: `unknown RADIUS code ${codeNum}` };
  const identifier = bytes[1];
  const length = (bytes[2] << 8) | bytes[3];
  if (length < 20 || length > bytes.length) {
    return { error: `invalid packet length field ${length} (buffer is ${bytes.length} bytes)` };
  }
  const authenticator = bytesToHex(bytes.subarray(4, 20));
  const attrsResult = decodeAttributes(bytes.subarray(20, length));
  if (isRadiusDecodeError(attrsResult)) return attrsResult;
  return {
    type: 'radius', code, identifier, authenticator, attributes: attrsResult,
    raw: bytes.subarray(0, length),
  };
}

function decodeAttributes(bytes: Uint8Array): RadiusAttribute[] | RadiusDecodeError {
  const attrs: RadiusAttribute[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) return { error: `truncated attribute header at offset ${offset}` };
    const type = bytes[offset];
    const length = bytes[offset + 1];
    if (length < 2) return { error: `invalid attribute length ${length} at offset ${offset}` };
    if (offset + length > bytes.length) {
      return { error: `attribute ${type} overruns packet (length ${length}) at offset ${offset}` };
    }
    const value = bytes.subarray(offset + 2, offset + length);
    if (type === VSA_ATTR_TYPE) {
      attrs.push(decodeVsaAttribute(value));
    } else {
      const def = RADIUS_DICTIONARY_BY_TYPE.get(type);
      if (def) attrs.push({ type: def.name, value: decodeValue(def.valueType, value) });
      // else: unrecognized attribute type — skip, don't fail the packet.
    }
    offset += length;
  }
  return attrs;
}

function decodeVsaAttribute(value: Uint8Array): RadiusAttribute {
  if (value.length < 6) return { type: 'vendor-specific', value: bytesToHex(value) };
  const vendorId = ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0;
  const vendorType = value[4];
  const vendorLength = value[5];
  const subValue = value.subarray(6, 4 + vendorLength);
  const vsaDef = lookupVsa(vendorId, vendorType);
  return {
    type: 'vendor-specific',
    value: decodeValue(vsaDef?.valueType ?? 'octets', subValue),
    vendor: { id: vendorId, type: vendorType },
  };
}

function decodeValue(valueType: RadiusValueType, bytes: Uint8Array): string | number {
  switch (valueType) {
    case 'text':
    case 'string':
      return bytesToUtf8(bytes);
    case 'address':
      return bytesToIp(bytes);
    case 'integer':
    case 'time':
      return bytesToUint32(bytes);
    case 'octets':
      return bytesToHex(bytes);
    case 'tagged-integer':
      return ((bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    case 'tagged-string':
      return bytesToUtf8(bytes.subarray(1));
  }
}

// ─── Byte helpers ────────────────────────────────────────────────────

function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`encodeRadiusPacket: invalid IPv4 address "${ip}"`);
  }
  return Uint8Array.from(parts);
}

function bytesToIp(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 4)).join('.');
}

function uint32ToBytes(n: number): Uint8Array {
  const v = n >>> 0;
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function bytesToUint32(bytes: Uint8Array): number {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
