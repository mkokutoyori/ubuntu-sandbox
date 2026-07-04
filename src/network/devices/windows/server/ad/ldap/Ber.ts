/**
 * Ber — ASN.1 BER (Basic Encoding Rules) codec, X.690 §8, restricted to
 * the subset RFC 4511 §5.1 requires of LDAP: definite-length encoding
 * only (no indefinite-length constructed forms), primitive/constructed
 * SEQUENCE/SET, INTEGER, BOOLEAN, ENUMERATED, OCTET STRING, NULL, and
 * context-specific/application tags (both primitive and constructed).
 *
 * This is a real byte-level codec (Uint8Array in, Uint8Array out) — not
 * a JSON stand-in — used by LdapMessage.ts to build genuine LDAP PDUs.
 */

export type BerTagClass = 'universal' | 'application' | 'context' | 'private';

export interface BerNode {
  readonly tagClass: BerTagClass;
  readonly constructed: boolean;
  readonly tagNumber: number;
  /** Raw content octets (primitive) or the concatenated encoding of children (constructed). */
  readonly content: Uint8Array;
}

/** Parsed TLV plus where the next sibling starts, for iterative decoding of SEQUENCE/SET bodies. */
export interface ParsedTLV extends BerNode {
  readonly nextOffset: number;
}

const CLASS_BITS: Record<BerTagClass, number> = {
  universal: 0x00,
  application: 0x40,
  context: 0x80,
  private: 0xc0,
};

export const UNIVERSAL_TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  ENUMERATED: 0x0a,
  SEQUENCE: 0x10,
  SET: 0x11,
} as const;

// ─── Length ─────────────────────────────────────────────────────────────────

function encodeLength(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return [0x80 | bytes.length, ...bytes];
}

function decodeLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error('BER: truncated length');
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0) throw new Error('BER: indefinite length not supported (LDAP requires definite length)');
  if (offset + 1 + numBytes > bytes.length) throw new Error('BER: truncated length');
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = length * 256 + bytes[offset + 1 + i];
  return { length, next: offset + 1 + numBytes };
}

// ─── Tag + TLV construction ─────────────────────────────────────────────────

function encodeTag(tagClass: BerTagClass, constructed: boolean, tagNumber: number): number[] {
  if (tagNumber < 0 || tagNumber > 30) {
    // High-tag-number form — LDAP never needs tag numbers above 30, but
    // encode it correctly rather than silently truncating.
    const bytes: number[] = [];
    let n = tagNumber;
    const tail: number[] = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) { tail.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    bytes.push(CLASS_BITS[tagClass] | (constructed ? 0x20 : 0x00) | 0x1f, ...tail);
    return bytes;
  }
  return [CLASS_BITS[tagClass] | (constructed ? 0x20 : 0x00) | tagNumber];
}

export function encodeTLV(tagClass: BerTagClass, tagNumber: number, constructed: boolean, content: Uint8Array): Uint8Array {
  const tag = encodeTag(tagClass, constructed, tagNumber);
  const len = encodeLength(content.length);
  const out = new Uint8Array(tag.length + len.length + content.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(content, tag.length + len.length);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export function parseTLV(bytes: Uint8Array, offset: number): ParsedTLV {
  const first = bytes[offset];
  if (first === undefined) throw new Error('BER: truncated tag');
  const classBits = first & 0xc0;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;
  let pos = offset + 1;
  if (tagNumber === 0x1f) {
    tagNumber = 0;
    for (;;) {
      const b = bytes[pos]; pos++;
      if (b === undefined) throw new Error('BER: truncated high-tag-number');
      tagNumber = tagNumber * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  const tagClass: BerTagClass =
    classBits === 0x00 ? 'universal' : classBits === 0x40 ? 'application' : classBits === 0x80 ? 'context' : 'private';
  const { length, next } = decodeLength(bytes, pos);
  const contentStart = next;
  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) throw new Error('BER: truncated content');
  return {
    tagClass, constructed, tagNumber,
    content: bytes.slice(contentStart, contentEnd),
    nextOffset: contentEnd,
  };
}

/** Parse every sibling TLV in a constructed node's content (SEQUENCE/SET body, or a whole buffer). */
export function parseAll(bytes: Uint8Array): ParsedTLV[] {
  const out: ParsedTLV[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const node = parseTLV(bytes, offset);
    out.push(node);
    offset = node.nextOffset;
  }
  return out;
}

// ─── Universal type helpers ─────────────────────────────────────────────────

export function encodeInteger(n: number): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.INTEGER, false, encodeIntegerContent(n));
}
export function encodeEnumerated(n: number): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.ENUMERATED, false, encodeIntegerContent(n));
}
function encodeIntegerContent(n: number): Uint8Array {
  if (!Number.isInteger(n)) throw new Error(`BER: not an integer: ${n}`);
  if (n === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  if (n > 0) {
    let value = n;
    while (value > 0) { bytes.unshift(value & 0xff); value = Math.floor(value / 256); }
    if ((bytes[0] & 0x80) !== 0) bytes.unshift(0x00); // avoid sign ambiguity with a leading 1-bit
  } else {
    // Minimal two's-complement width: smallest b (bytes) such that -(2^(8b-1)) <= n.
    let widthBytes = 1;
    while (n < -Math.pow(2, 8 * widthBytes - 1)) widthBytes++;
    let twos = Math.pow(2, 8 * widthBytes) + n; // non-negative two's-complement value
    for (let i = 0; i < widthBytes; i++) { bytes.unshift(twos & 0xff); twos = Math.floor(twos / 256); }
  }
  return new Uint8Array(bytes);
}
export function decodeInteger(content: Uint8Array): number {
  if (content.length === 0) return 0;
  let value = content[0] & 0x80 ? -1 : 0;
  for (const b of content) value = value * 256 + b;
  return value;
}

export function encodeBoolean(b: boolean): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.BOOLEAN, false, new Uint8Array([b ? 0xff : 0x00]));
}
export function decodeBoolean(content: Uint8Array): boolean {
  return content.length > 0 && content[0] !== 0x00;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export function encodeOctetString(s: string): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.OCTET_STRING, false, utf8Encoder.encode(s));
}
export function decodeOctetString(content: Uint8Array): string {
  return utf8Decoder.decode(content);
}

export function encodeNull(): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.NULL, false, new Uint8Array(0));
}

export function encodeSequence(children: Uint8Array[]): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.SEQUENCE, true, concat(children));
}
export function encodeSet(children: Uint8Array[]): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.SET, true, concat(children));
}

/** Context-specific tag carrying raw content directly (e.g. `[0] OCTET STRING` for a simple bind password). */
export function encodeContextPrimitive(tagNumber: number, content: Uint8Array): Uint8Array {
  return encodeTLV('context', tagNumber, false, content);
}
export function encodeContextPrimitiveString(tagNumber: number, s: string): Uint8Array {
  return encodeContextPrimitive(tagNumber, utf8Encoder.encode(s));
}
/** Context-specific tag wrapping a SEQUENCE/SET/CHOICE of children (constructed). */
export function encodeContextConstructed(tagNumber: number, children: Uint8Array[]): Uint8Array {
  return encodeTLV('context', tagNumber, true, concat(children));
}
export function encodeApplication(tagNumber: number, constructed: boolean, content: Uint8Array): Uint8Array {
  return encodeTLV('application', tagNumber, constructed, content);
}
