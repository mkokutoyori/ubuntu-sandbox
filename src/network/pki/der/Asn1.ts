import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  ENUMERATED: 0x0a,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

export function contextTag(number: number, constructed: boolean): number {
  return 0x80 | (constructed ? 0x20 : 0) | number;
}

export class DerError extends Error {}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function lengthOctets(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), lengthOctets(content.length), content]);
}

export const der = {
  sequence: (...items: readonly Uint8Array[]): Uint8Array => tlv(TAG.SEQUENCE, concatBytes(items)),
  set: (...items: readonly Uint8Array[]): Uint8Array => tlv(TAG.SET, concatBytes(items)),
  explicit: (number: number, inner: Uint8Array): Uint8Array => tlv(contextTag(number, true), inner),
  implicit: (number: number, content: Uint8Array, constructed = false): Uint8Array => tlv(contextTag(number, constructed), content),
  boolean: (value: boolean): Uint8Array => tlv(TAG.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00)),
  null: (): Uint8Array => tlv(TAG.NULL, new Uint8Array(0)),
  octetString: (bytes: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, bytes),
  utf8String: (text: string): Uint8Array => tlv(TAG.UTF8_STRING, utf8ToBytes(text)),
  printableString: (text: string): Uint8Array => tlv(TAG.PRINTABLE_STRING, utf8ToBytes(text)),
  ia5String: (text: string): Uint8Array => tlv(TAG.IA5_STRING, utf8ToBytes(text)),
  integer: (value: bigint): Uint8Array => tlv(TAG.INTEGER, integerContent(value)),
  enumerated: (value: number): Uint8Array => tlv(TAG.ENUMERATED, integerContent(BigInt(value))),
  oid: (dotted: string): Uint8Array => tlv(TAG.OID, oidContent(dotted)),
  bitString: (bytes: Uint8Array, unusedBits = 0): Uint8Array => tlv(TAG.BIT_STRING, concatBytes([Uint8Array.of(unusedBits), bytes])),
  time: (epochMs: number): Uint8Array => encodeTime(epochMs),
};

function integerContent(value: bigint): Uint8Array {
  if (value === 0n) return Uint8Array.of(0);
  const bytes: number[] = [];
  if (value > 0n) {
    let rest = value;
    while (rest > 0n) { bytes.unshift(Number(rest & 0xffn)); rest >>= 8n; }
    if (bytes[0] & 0x80) bytes.unshift(0);
  } else {
    let width = 1;
    while (-(1n << BigInt(8 * width - 1)) > value) width++;
    let rest = (1n << BigInt(8 * width)) + value;
    for (let i = 0; i < width; i++) { bytes.unshift(Number(rest & 0xffn)); rest >>= 8n; }
  }
  return Uint8Array.from(bytes);
}

export function unsignedIntegerBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.slice(start);
  const content = trimmed.length > 0 && trimmed[0] & 0x80 ? concatBytes([Uint8Array.of(0), trimmed]) : trimmed;
  return tlv(TAG.INTEGER, content.length === 0 ? Uint8Array.of(0) : content);
}

function oidContent(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map((part) => BigInt(part));
  if (arcs.length < 2) throw new DerError(`invalid object identifier ${dotted}`);
  const out: number[] = [];
  const push = (value: bigint): void => {
    const chunk: number[] = [Number(value & 0x7fn)];
    for (let rest = value >> 7n; rest > 0n; rest >>= 7n) chunk.unshift(Number(rest & 0x7fn) | 0x80);
    out.push(...chunk);
  };
  push(arcs[0] * 40n + arcs[1]);
  for (const arc of arcs.slice(2)) push(arc);
  return Uint8Array.from(out);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function encodeTime(epochMs: number): Uint8Array {
  const date = new Date(Math.floor(epochMs / 1000) * 1000);
  const year = date.getUTCFullYear();
  const rest = `${twoDigits(date.getUTCMonth() + 1)}${twoDigits(date.getUTCDate())}${twoDigits(date.getUTCHours())}${twoDigits(date.getUTCMinutes())}${twoDigits(date.getUTCSeconds())}Z`;
  if (year >= 1950 && year < 2050) return tlv(TAG.UTC_TIME, utf8ToBytes(`${twoDigits(year % 100)}${rest}`));
  return tlv(TAG.GENERALIZED_TIME, utf8ToBytes(`${String(year).padStart(4, '0')}${rest}`));
}

export interface DerNode {
  readonly tag: number;
  readonly content: Uint8Array;
  readonly raw: Uint8Array;
}

export function readNode(bytes: Uint8Array, offset = 0): { node: DerNode; end: number } {
  if (offset + 2 > bytes.length) throw new DerError('truncated DER element');
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError('high tag numbers are not supported');
  let cursor = offset + 1;
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) throw new DerError('invalid DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (end > bytes.length) throw new DerError('DER element overruns its container');
  return { node: { tag, content: bytes.slice(cursor, end), raw: bytes.slice(offset, end) }, end };
}

export function children(node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, end } = readNode(node.content, offset);
    out.push(child);
    offset = end;
  }
  return out;
}

export function parseDer(bytes: Uint8Array): DerNode {
  const { node, end } = readNode(bytes, 0);
  if (end !== bytes.length) throw new DerError('trailing bytes after DER element');
  return node;
}

export function expectTag(node: DerNode, tag: number, what: string): DerNode {
  if (node.tag !== tag) throw new DerError(`${what}: unexpected tag 0x${node.tag.toString(16)}`);
  return node;
}

export function integerValue(node: DerNode): bigint {
  expectTag(node, TAG.INTEGER, 'INTEGER');
  let value = 0n;
  for (const byte of node.content) value = (value << 8n) | BigInt(byte);
  if (node.content.length > 0 && node.content[0] & 0x80) value -= 1n << BigInt(8 * node.content.length);
  return value;
}

export function integerMagnitude(node: DerNode): Uint8Array {
  expectTag(node, TAG.INTEGER, 'INTEGER');
  let start = 0;
  while (start < node.content.length - 1 && node.content[start] === 0) start++;
  return node.content.slice(start);
}

export function oidValue(node: DerNode): string {
  expectTag(node, TAG.OID, 'OBJECT IDENTIFIER');
  const arcs: bigint[] = [];
  let current = 0n;
  for (const byte of node.content) {
    current = (current << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) { arcs.push(current); current = 0n; }
  }
  const first = arcs[0];
  const head = first < 80n ? [first / 40n, first % 40n] : [2n, first - 80n];
  return [...head, ...arcs.slice(1)].join('.');
}

export function stringValue(node: DerNode): string {
  return bytesToUtf8(node.content);
}

export function bitStringBytes(node: DerNode): { bytes: Uint8Array; unusedBits: number } {
  expectTag(node, TAG.BIT_STRING, 'BIT STRING');
  return { bytes: node.content.slice(1), unusedBits: node.content[0] ?? 0 };
}

export function timeValue(node: DerNode): number {
  const text = stringValue(node);
  const pattern = node.tag === TAG.UTC_TIME ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;
  const match = pattern.exec(text);
  if (!match || (node.tag !== TAG.UTC_TIME && node.tag !== TAG.GENERALIZED_TIME)) throw new DerError(`invalid time ${text}`);
  const yearField = Number(match[1]);
  const year = node.tag === TAG.UTC_TIME ? (yearField >= 50 ? 1900 + yearField : 2000 + yearField) : yearField;
  return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}
