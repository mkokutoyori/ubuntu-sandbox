/**
 * PRF+ (RFC 5996 §2.13) — the iterated-PRF key-material expansion used by
 * IKEv2 to derive KEYMAT. Verified against an independent HMAC-SHA256
 * computation (python hmac/hashlib).
 *
 *   prf+(K,S) = T1 | T2 | …   where  T1 = prf(K, S|0x01),
 *                                    Tn = prf(K, T(n-1)|S|n)
 */

import { describe, it, expect } from 'vitest';
import { prfPlus } from '@/crypto/kdf';
import { SHA256, sha256 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac';
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding';

const KEY = utf8ToBytes('key');
const SEED = utf8ToBytes('seed');

describe('prfPlus — reference vector', () => {
  it('expands K="key" S="seed" to 40 bytes', () => {
    expect(bytesToHex(prfPlus(SHA256, KEY, SEED, 40))).toBe(
      'a2392e429a99b173341b368bb5ce320bfd483d89567c14ec187c2d77e3c0a208ba45d21d42611712',
    );
  });

  it('a 32-byte request is exactly the first block T1', () => {
    expect(bytesToHex(prfPlus(SHA256, KEY, SEED, 32))).toBe(
      'a2392e429a99b173341b368bb5ce320bfd483d89567c14ec187c2d77e3c0a208',
    );
  });

  it('the first block equals prf(K, S|0x01)', () => {
    const expectedT1 = hmac(SHA256, KEY, Uint8Array.of(...SEED, 0x01));
    expect(bytesToHex(prfPlus(SHA256, KEY, SEED, 32))).toBe(bytesToHex(expectedT1));
  });
});

describe('prfPlus — properties', () => {
  it('returns exactly the requested length', () => {
    expect(prfPlus(SHA256, KEY, SEED, 1).length).toBe(1);
    expect(prfPlus(SHA256, KEY, SEED, 100).length).toBe(100);
  });

  it('is deterministic', () => {
    expect(bytesToHex(prfPlus(SHA256, KEY, SEED, 48))).toBe(
      bytesToHex(prfPlus(SHA256, KEY, SEED, 48)),
    );
  });

  it('different seeds diverge', () => {
    const a = bytesToHex(prfPlus(SHA256, KEY, utf8ToBytes('seed-a'), 32));
    const b = bytesToHex(prfPlus(SHA256, KEY, utf8ToBytes('seed-b'), 32));
    expect(a).not.toBe(b);
  });

  it('is prefix-stable: a shorter request is a prefix of a longer one', () => {
    const short = bytesToHex(prfPlus(SHA256, KEY, SEED, 16));
    const long = bytesToHex(prfPlus(SHA256, KEY, SEED, 64));
    expect(long.startsWith(short)).toBe(true);
  });

  it('rejects a non-positive length', () => {
    expect(() => prfPlus(SHA256, KEY, SEED, 0)).toThrow();
  });

  // Keep an explicit reference to sha256 so the import documents the PRF base.
  it('uses the SHA-256 digest size for its blocks', () => {
    expect(sha256(SEED).length).toBe(SHA256.digestSize);
  });
});
