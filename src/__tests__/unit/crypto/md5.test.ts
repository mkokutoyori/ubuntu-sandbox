/**
 * MD5 — verified against the RFC 1321 Appendix A.5 "MD5 test suite".
 *
 * MD5 is cryptographically broken for collision resistance, but it remains
 * the wire/format reality for Cisco type-5 secrets ($1$), IKE/IPSec HMAC-MD5,
 * and legacy Unix crypt — so the simulator needs the genuine algorithm.
 */

import { describe, it, expect } from 'vitest';
import { md5, md5Hex, MD5 } from '@/crypto/hash';
import { utf8ToBytes } from '@/crypto/encoding';

describe('md5Hex — RFC 1321 test suite', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ])('md5(%j)', (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });

  it('hashes a message that forces a second padding block', () => {
    // 56 bytes: padding cannot fit in the same block, so a full extra block is added.
    expect(md5Hex('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });
});

describe('md5 — raw digest', () => {
  it('returns a 16-byte Uint8Array', () => {
    const digest = md5(utf8ToBytes('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(16);
  });

  it('does not mutate its input buffer', () => {
    const input = utf8ToBytes('immutable');
    const copy = Uint8Array.from(input);
    md5(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('MD5 algorithm descriptor', () => {
  it('declares a 64-byte block and 16-byte digest', () => {
    expect(MD5.blockSize).toBe(64);
    expect(MD5.digestSize).toBe(16);
  });
});
