import { beToBig, bigToBe, byteLength, type RsaPublicKey } from '@/crypto/rsa/rsa';

const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let v = length; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: ArrayLike<number>): number[] {
  return [tag, ...lengthBytes(content.length), ...Array.from(content)];
}

function derInteger(value: bigint): number[] {
  const raw = Array.from(bigToBe(value, byteLength(value)));
  return tlv(0x02, raw[0] >= 0x80 ? [0, ...raw] : raw);
}

export function encodeRsaPublicKey(key: RsaPublicKey): Uint8Array {
  const rsaPublicKey = tlv(0x30, [...derInteger(key.n), ...derInteger(key.e)]);
  const bitString = tlv(0x03, [0, ...rsaPublicKey]);
  return Uint8Array.from(tlv(0x30, [...RSA_ENCRYPTION_ALGORITHM_IDENTIFIER, ...bitString]));
}

interface Element { tag: number; content: Uint8Array; end: number }

function readElement(bytes: Uint8Array, offset: number): Element | null {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let cursor = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > bytes.length) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[cursor++];
  }
  if (cursor + length > bytes.length) return null;
  return { tag, content: bytes.subarray(cursor, cursor + length), end: cursor + length };
}

export function decodeRsaPublicKey(bytes: Uint8Array): RsaPublicKey | null {
  const spki = readElement(bytes, 0);
  if (!spki || spki.tag !== 0x30 || spki.end !== bytes.length) return null;
  const algorithm = readElement(spki.content, 0);
  if (!algorithm || algorithm.tag !== 0x30) return null;
  const given = Array.from(spki.content.subarray(0, algorithm.end));
  if (given.length !== RSA_ENCRYPTION_ALGORITHM_IDENTIFIER.length
      || given.some((value, index) => value !== RSA_ENCRYPTION_ALGORITHM_IDENTIFIER[index])) return null;
  const bitString = readElement(spki.content, algorithm.end);
  if (!bitString || bitString.tag !== 0x03 || bitString.content[0] !== 0) return null;
  const sequence = readElement(bitString.content, 1);
  if (!sequence || sequence.tag !== 0x30) return null;
  const modulus = readElement(sequence.content, 0);
  if (!modulus || modulus.tag !== 0x02) return null;
  const exponent = readElement(sequence.content, modulus.end);
  if (!exponent || exponent.tag !== 0x02 || exponent.end !== sequence.content.length) return null;
  return { n: beToBig(modulus.content), e: beToBig(exponent.content) };
}

export function groupedHex(bytes: Uint8Array, groupsPerLine = 8): string[] {
  const hex = Array.from(bytes, (value) => value.toString(16).toUpperCase().padStart(2, '0')).join('');
  const groups = hex.match(/.{1,8}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += groupsPerLine) lines.push(groups.slice(i, i + groupsPerLine).join(' '));
  return lines;
}

export function parseHexKeyString(lines: readonly string[]): Uint8Array | null {
  const hex = lines.join('').replace(/\s+/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
}
