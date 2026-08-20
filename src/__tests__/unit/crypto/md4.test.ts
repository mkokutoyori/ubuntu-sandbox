/**
 * MD4 — verified against the RFC 1320 §A.5 "MD4 test suite".
 *
 * MD4 is cryptographically broken and provided solely as the building block
 * MS-CHAPv2's NT-Password-Hash requires (RFC 2759 §8.1).
 */

import { describe, it, expect } from 'vitest';
import { md4 } from '@/crypto/hash';
import { utf8ToBytes, bytesToHex } from '@/crypto/encoding';

function md4Hex(text: string): string {
  return bytesToHex(md4(utf8ToBytes(text)));
}

describe('md4 — RFC 1320 test suite', () => {
  it.each([
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      '043f8582f241db351ce627e153e7f0e4',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      'e33b4ddc9c38f2199c3e7b164fcc0536',
    ],
  ])('md4(%j)', (input, expected) => {
    expect(md4Hex(input)).toBe(expected);
  });
});

describe('md4 — raw digest', () => {
  it('returns a 16-byte Uint8Array', () => {
    const digest = md4(utf8ToBytes('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(16);
  });

  it('does not mutate its input buffer', () => {
    const input = utf8ToBytes('immutable');
    const copy = Uint8Array.from(input);
    md4(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});
