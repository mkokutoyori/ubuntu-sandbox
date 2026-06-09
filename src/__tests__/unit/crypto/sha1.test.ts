/**
 * SHA-1 — verified against the FIPS 180-1 / RFC 3174 published vectors.
 *
 * Needed for the genuine OpenSSH `HashKnownHosts` token (HMAC-SHA1) and as an
 * IKE/IPSec integrity primitive (hmac-sha-1).
 */

import { describe, it, expect } from 'vitest';
import { sha1, sha1Hex, SHA1 } from '@/crypto/hash';
import { utf8ToBytes } from '@/crypto/encoding';

describe('sha1Hex — FIPS 180-1 / RFC 3174 vectors', () => {
  it.each([
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    ],
    [
      'The quick brown fox jumps over the lazy dog',
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    ],
  ])('sha1(%j)', (input, expected) => {
    expect(sha1Hex(input)).toBe(expected);
  });

  it('hashes one million "a" characters (RFC 3174 long message)', () => {
    expect(sha1Hex('a'.repeat(1_000_000))).toBe(
      '34aa973cd4c4daa4f61eeb2bdbad27316534016f',
    );
  });
});

describe('sha1 — raw digest', () => {
  it('returns a 20-byte Uint8Array', () => {
    const digest = sha1(utf8ToBytes('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(20);
  });

  it('does not mutate its input buffer', () => {
    const input = utf8ToBytes('immutable');
    const copy = Uint8Array.from(input);
    sha1(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('SHA1 algorithm descriptor', () => {
  it('declares a 64-byte block and 20-byte digest', () => {
    expect(SHA1.blockSize).toBe(64);
    expect(SHA1.digestSize).toBe(20);
  });
});
