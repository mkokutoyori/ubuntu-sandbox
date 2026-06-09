/**
 * SHA-512 (FIPS 180-4) — verified against the published vectors. Needed for
 * the Oracle 12c password verifier (PBKDF2-HMAC-SHA512) and DBMS_CRYPTO.
 */

import { describe, it, expect } from 'vitest';
import { sha512, sha512Hex, SHA512 } from '@/crypto/hash';
import { utf8ToBytes } from '@/crypto/encoding';

describe('sha512Hex — FIPS 180-4 vectors', () => {
  it.each([
    ['', 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'],
    ['abc', 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'],
    ['The quick brown fox jumps over the lazy dog', '07e547d9586f6a73f73fbac0435ed76951218fb7d0c8d788a309d785436bbb642e93a252a954f23912547d1e8a3b5ed6e1bfd7097821233fa0538f3db854fee6'],
  ])('sha512(%j)', (input, expected) => {
    expect(sha512Hex(input)).toBe(expected);
  });

  it('hashes the 112-byte two-block message', () => {
    const msg =
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
    expect(sha512Hex(msg)).toBe(
      '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909',
    );
  });

  it('hashes one million "a" characters', () => {
    expect(sha512Hex('a'.repeat(1_000_000))).toBe(
      'e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b',
    );
  });
});

describe('sha512 — raw digest', () => {
  it('returns a 64-byte Uint8Array', () => {
    const d = sha512(utf8ToBytes('abc'));
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(64);
  });

  it('does not mutate its input', () => {
    const input = utf8ToBytes('immutable');
    const copy = Uint8Array.from(input);
    sha512(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('SHA512 descriptor', () => {
  it('declares a 128-byte block and 64-byte digest', () => {
    expect(SHA512.blockSize).toBe(128);
    expect(SHA512.digestSize).toBe(64);
  });
});
