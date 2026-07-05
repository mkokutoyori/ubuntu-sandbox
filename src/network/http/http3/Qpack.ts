// RFC 9204 — QPACK header compression, static table only (cf. PRD-HTTP.md
// §2.2: dynamic table, and therefore encoder/decoder streams, is an
// explicit non-goal for this phase). Literal string encoding only, same
// convention as HPACK (`@/network/http/http2/Hpack.ts`) — no Huffman.
//
// The prefixed-integer and string-literal wire formats are byte-for-byte
// the same as HPACK's (RFC 9204 §4.1.1/§4.1.2 call this out explicitly),
// so this module reuses `encodeInteger`/`decodeInteger`/`encodeString`/
// `decodeString` from Hpack.ts rather than duplicating them.
import { encodeInteger, decodeInteger, encodeString, decodeString } from '@/network/http/http2/Hpack';

export interface QpackFieldLine {
  name: string;
  value: string;
}

// RFC 9204 Appendix A — the 0-indexed static table (unlike HPACK's 1-indexed one).
export const STATIC_TABLE: QpackFieldLine[] = [
  { name: ':authority', value: '' },
  { name: ':path', value: '/' },
  { name: 'age', value: '0' },
  { name: 'content-disposition', value: '' },
  { name: 'content-length', value: '0' },
  { name: 'cookie', value: '' },
  { name: 'date', value: '' },
  { name: 'etag', value: '' },
  { name: 'if-modified-since', value: '' },
  { name: 'if-none-match', value: '' },
  { name: 'last-modified', value: '' },
  { name: 'link', value: '' },
  { name: 'location', value: '' },
  { name: 'referer', value: '' },
  { name: 'set-cookie', value: '' },
  { name: ':method', value: 'CONNECT' },
  { name: ':method', value: 'DELETE' },
  { name: ':method', value: 'GET' },
  { name: ':method', value: 'HEAD' },
  { name: ':method', value: 'OPTIONS' },
  { name: ':method', value: 'POST' },
  { name: ':method', value: 'PUT' },
  { name: ':scheme', value: 'http' },
  { name: ':scheme', value: 'https' },
  { name: ':status', value: '103' },
  { name: ':status', value: '200' },
  { name: ':status', value: '304' },
  { name: ':status', value: '404' },
  { name: ':status', value: '503' },
  { name: 'accept', value: '*/*' },
  { name: 'accept', value: 'application/dns-message' },
  { name: 'accept-encoding', value: 'gzip, deflate, br' },
  { name: 'accept-ranges', value: 'bytes' },
  { name: 'access-control-allow-headers', value: 'cache-control' },
  { name: 'access-control-allow-headers', value: 'content-type' },
  { name: 'access-control-allow-origin', value: '*' },
  { name: 'cache-control', value: 'max-age=0' },
  { name: 'cache-control', value: 'max-age=2592000' },
  { name: 'cache-control', value: 'max-age=604800' },
  { name: 'cache-control', value: 'no-cache' },
  { name: 'cache-control', value: 'no-store' },
  { name: 'cache-control', value: 'public, max-age=31536000' },
  { name: 'content-encoding', value: 'br' },
  { name: 'content-encoding', value: 'gzip' },
  { name: 'content-type', value: 'application/dns-message' },
  { name: 'content-type', value: 'application/javascript' },
  { name: 'content-type', value: 'application/json' },
  { name: 'content-type', value: 'application/x-www-form-urlencoded' },
  { name: 'content-type', value: 'image/gif' },
  { name: 'content-type', value: 'image/jpeg' },
  { name: 'content-type', value: 'image/png' },
  { name: 'content-type', value: 'text/css' },
  { name: 'content-type', value: 'text/html; charset=utf-8' },
  { name: 'content-type', value: 'text/plain' },
  { name: 'content-type', value: 'text/plain;charset=utf-8' },
  { name: 'range', value: 'bytes=0-' },
  { name: 'strict-transport-security', value: 'max-age=31536000' },
  { name: 'strict-transport-security', value: 'max-age=31536000; includesubdomains' },
  { name: 'strict-transport-security', value: 'max-age=31536000; includesubdomains; preload' },
  { name: 'vary', value: 'accept-encoding' },
  { name: 'vary', value: 'origin' },
  { name: 'x-content-type-options', value: 'nosniff' },
  { name: 'x-xss-protection', value: '1; mode=block' },
  { name: ':status', value: '100' },
  { name: ':status', value: '204' },
  { name: ':status', value: '206' },
  { name: ':status', value: '302' },
  { name: ':status', value: '400' },
  { name: ':status', value: '403' },
  { name: ':status', value: '421' },
  { name: ':status', value: '425' },
  { name: ':status', value: '500' },
  { name: 'accept-language', value: '' },
  { name: 'access-control-allow-credentials', value: 'FALSE' },
  { name: 'access-control-allow-credentials', value: 'TRUE' },
  { name: 'access-control-allow-headers', value: '*' },
  { name: 'access-control-allow-methods', value: 'get' },
  { name: 'access-control-allow-methods', value: 'get, post, options' },
  { name: 'access-control-allow-methods', value: 'options' },
  { name: 'access-control-expose-headers', value: 'content-length' },
  { name: 'access-control-request-headers', value: 'content-type' },
  { name: 'access-control-request-method', value: 'get' },
  { name: 'access-control-request-method', value: 'post' },
  { name: 'alt-svc', value: 'clear' },
  { name: 'authorization', value: '' },
  { name: 'content-security-policy', value: "script-src 'none'; object-src 'none'; base-uri 'none'" },
  { name: 'early-data', value: '1' },
  { name: 'expect-ct', value: '' },
  { name: 'forwarded', value: '' },
  { name: 'if-range', value: '' },
  { name: 'origin', value: '' },
  { name: 'purpose', value: 'prefetch' },
  { name: 'server', value: '' },
  { name: 'timing-allow-origin', value: '*' },
  { name: 'upgrade-insecure-requests', value: '1' },
  { name: 'user-agent', value: '' },
  { name: 'x-forwarded-for', value: '' },
  { name: 'x-frame-options', value: 'deny' },
  { name: 'x-frame-options', value: 'sameorigin' },
];

function findExact(name: string, value: string): number | null {
  const index = STATIC_TABLE.findIndex((e) => e.name === name && e.value === value);
  return index === -1 ? null : index;
}

function findNameOnly(name: string): number | null {
  const index = STATIC_TABLE.findIndex((e) => e.name === name);
  return index === -1 ? null : index;
}

/** RFC 9204 §4.5.2 — Indexed Field Line, static table only (`1 1 index(6-bit prefix)`). */
function encodeIndexedStatic(index: number): number[] {
  return encodeInteger(index, 6, 0xc0);
}

/** RFC 9204 §4.5.4 — Literal Field Line With Name Reference, static, never-indexed=0 (`0 1 0 1 index(4-bit prefix)`). */
function encodeLiteralWithNameRef(index: number, value: string): number[] {
  return [...encodeInteger(index, 4, 0x50), ...encodeString(value)];
}

/** RFC 9204 §4.5.6 — Literal Field Line With Literal Name, N=0/H=0 (`0 0 1 0 0 nameLength(3-bit prefix)`). */
function encodeLiteralWithLiteralName(name: string, value: string): number[] {
  const nameBytes = Array.from(new TextEncoder().encode(name));
  return [...encodeInteger(nameBytes.length, 3, 0x20), ...nameBytes, ...encodeString(value)];
}

function encodeFieldLine(name: string, value: string): number[] {
  const exact = findExact(name, value);
  if (exact !== null) return encodeIndexedStatic(exact);

  const nameOnly = findNameOnly(name);
  if (nameOnly !== null) return encodeLiteralWithNameRef(nameOnly, value);

  return encodeLiteralWithLiteralName(name, value);
}

/**
 * RFC 9204 §4.5.1 — every field section is prefixed by an encoded Required
 * Insert Count and a signed Delta Base. With no dynamic table, both are
 * always 0 (the RIC=0 special case collapses its obfuscated encoding to a
 * literal 0, per §4.5.1.1), so the prefix is always the fixed 2 bytes
 * `[0x00, 0x00]`.
 */
const STATIC_ONLY_PREFIX = new Uint8Array([0x00, 0x00]);

export function encodeFieldSection(headers: [string, string][]): Uint8Array {
  const body = headers.flatMap(([name, value]) => encodeFieldLine(name, value));
  return new Uint8Array([...STATIC_ONLY_PREFIX, ...body]);
}

export function decodeFieldSection(bytes: Uint8Array): [string, string][] {
  let offset = 0;
  const ric = decodeInteger(bytes, offset, 8);
  offset += ric.bytesConsumed;
  const deltaBase = decodeInteger(bytes, offset, 7);
  offset += deltaBase.bytesConsumed;

  const headers: [string, string][] = [];
  while (offset < bytes.length) {
    const first = bytes[offset];

    if (first & 0x80) {
      const { value: index, bytesConsumed } = decodeInteger(bytes, offset, 6);
      const entry = STATIC_TABLE[index];
      if (!entry) throw new Error(`Qpack: static table index ${index} out of range`);
      headers.push([entry.name, entry.value]);
      offset += bytesConsumed;
      continue;
    }

    if (first & 0x40) {
      const { value: index, bytesConsumed } = decodeInteger(bytes, offset, 4);
      offset += bytesConsumed;
      const entry = STATIC_TABLE[index];
      if (!entry) throw new Error(`Qpack: static table index ${index} out of range`);
      const val = decodeString(bytes, offset);
      if (!val) throw new Error('Qpack: malformed value string');
      offset += val.bytesConsumed;
      headers.push([entry.name, val.value]);
      continue;
    }

    if (first & 0x20) {
      const { value: nameLen, bytesConsumed } = decodeInteger(bytes, offset, 3);
      offset += bytesConsumed;
      const nameBytes = bytes.slice(offset, offset + nameLen);
      offset += nameLen;
      const val = decodeString(bytes, offset);
      if (!val) throw new Error('Qpack: malformed value string');
      offset += val.bytesConsumed;
      headers.push([new TextDecoder().decode(nameBytes), val.value]);
      continue;
    }

    throw new Error('Qpack: dynamic-table field line representations are not supported (static table only, cf. PRD-HTTP.md §2.2)');
  }
  return headers;
}
