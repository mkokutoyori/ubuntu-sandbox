/**
 * SHA-256 — verified against the FIPS 180-4 published test vectors and the
 * canonical NIST examples. A wrong implementation cannot accidentally match
 * these, which is exactly why we migrate the simulator's FNV "fingerprints"
 * onto a real digest.
 */

import { describe, it, expect } from 'vitest';
import { sha256, sha256Hex, SHA256 } from '@/crypto/hash';
import { utf8ToBytes } from '@/crypto/encoding';

describe('sha256Hex — FIPS 180-4 / NIST vectors', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
    // A single changed character avalanches the whole digest.
    [
      'The quick brown fox jumps over the lazy dog.',
      'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c',
    ],
  ])('sha256(%j)', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('hashes the 112-byte two-block message (crosses the block boundary)', () => {
    const input =
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
    expect(sha256Hex(input)).toBe(
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    );
  });

  it('hashes one million "a" characters (FIPS long message)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('sha256 — raw digest', () => {
  it('returns a 32-byte Uint8Array', () => {
    const digest = sha256(utf8ToBytes('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
  });

  it('is deterministic', () => {
    expect(Array.from(sha256(utf8ToBytes('repeat')))).toEqual(
      Array.from(sha256(utf8ToBytes('repeat'))),
    );
  });

  it('does not mutate its input buffer', () => {
    const input = utf8ToBytes('immutable');
    const copy = Uint8Array.from(input);
    sha256(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});

describe('SHA256 algorithm descriptor', () => {
  it('declares the SHA-2 block and digest sizes', () => {
    expect(SHA256.blockSize).toBe(64);
    expect(SHA256.digestSize).toBe(32);
  });

  it('digest() matches the standalone function', () => {
    const msg = utf8ToBytes('descriptor');
    expect(Array.from(SHA256.digest(msg))).toEqual(Array.from(sha256(msg)));
  });
});
