/**
 * Tests for the byte/encoding primitives that underpin every hash and MAC.
 *
 * These functions are intentionally low-level (Uint8Array in/out) so the
 * hash implementations can stay environment-agnostic (browser + node).
 */

import { describe, it, expect } from 'vitest';
import {
  utf8ToBytes,
  bytesToUtf8,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
} from '@/crypto/encoding';

describe('utf8ToBytes', () => {
  it('encodes ASCII to its code points', () => {
    expect(Array.from(utf8ToBytes('abc'))).toEqual([0x61, 0x62, 0x63]);
  });

  it('returns an empty array for the empty string', () => {
    expect(Array.from(utf8ToBytes(''))).toEqual([]);
  });

  it('encodes a 2-byte UTF-8 sequence (é)', () => {
    expect(Array.from(utf8ToBytes('é'))).toEqual([0xc3, 0xa9]);
  });

  it('encodes a 4-byte UTF-8 sequence (emoji)', () => {
    expect(Array.from(utf8ToBytes('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});

describe('bytesToUtf8', () => {
  it('round-trips multibyte text', () => {
    const text = 'héllo 😀 мир';
    expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
  });
});

describe('bytesToHex', () => {
  it('lowercases and zero-pads each byte', () => {
    expect(bytesToHex(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).toBe('deadbeef');
  });

  it('pads single-digit bytes (0x0a -> "0a")', () => {
    expect(bytesToHex(Uint8Array.of(0x00, 0x0a, 0xff))).toBe('000aff');
  });

  it('returns empty string for empty input', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });
});

describe('hexToBytes', () => {
  it('parses a lowercase hex string', () => {
    expect(Array.from(hexToBytes('deadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('is case-insensitive', () => {
    expect(Array.from(hexToBytes('DEADBEEF'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('round-trips through bytesToHex', () => {
    const bytes = Uint8Array.of(0, 1, 127, 128, 255);
    expect(Array.from(hexToBytes(bytesToHex(bytes)))).toEqual(Array.from(bytes));
  });

  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd|length/i);
  });

  it('throws on non-hex characters', () => {
    expect(() => hexToBytes('zz')).toThrow(/hex/i);
  });
});

describe('bytesToBase64', () => {
  // RFC 4648 §10 test vectors.
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j to %j', (input, expected) => {
    expect(bytesToBase64(utf8ToBytes(input))).toBe(expected);
  });

  it('encodes high bytes correctly', () => {
    expect(bytesToBase64(Uint8Array.of(0xff, 0xff, 0xff))).toBe('////');
  });
});
