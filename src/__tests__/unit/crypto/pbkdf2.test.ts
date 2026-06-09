/**
 * PBKDF2 (RFC 2898 / PKCS#5) — verified against the RFC 6070 vectors
 * (HMAC-SHA1) and the widely-published HMAC-SHA256 vectors. Required for
 * Cisco type-8 secrets and a building block for other modern KDFs.
 */

import { describe, it, expect } from 'vitest';
import { pbkdf2, pbkdf2Hex } from '@/crypto/kdf';
import { SHA1, SHA256 } from '@/crypto/hash';
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding';

describe('PBKDF2-HMAC-SHA1 — RFC 6070', () => {
  it.each([
    [1, '0c60c80f961f0e71f3a9b524af6012062fe037a6'],
    [2, 'ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957'],
    [4096, '4b007901b765489abead49d926f721d065a429c1'],
  ])('c=%i, dkLen=20', (iterations, expected) => {
    expect(pbkdf2Hex(SHA1, 'password', 'salt', iterations, 20)).toBe(expected);
  });
});

describe('PBKDF2-HMAC-SHA256', () => {
  it.each([
    [1, 32, '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'],
    [2, 32, 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'],
    [4096, 32, 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a'],
  ])('password/salt c=%i dkLen=%i', (iterations, dkLen, expected) => {
    expect(pbkdf2Hex(SHA256, 'password', 'salt', iterations, dkLen)).toBe(expected);
  });

  it('derives a key longer than the digest size (multiple blocks)', () => {
    expect(pbkdf2Hex(SHA256, 'passwd', 'salt', 1, 64)).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc' +
        '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });
});

describe('pbkdf2 — raw', () => {
  it('returns exactly dkLen bytes', () => {
    expect(pbkdf2(SHA256, utf8ToBytes('p'), utf8ToBytes('s'), 1, 17).length).toBe(17);
  });

  it('is deterministic', () => {
    const a = bytesToHex(pbkdf2(SHA256, utf8ToBytes('p'), utf8ToBytes('s'), 10, 16));
    const b = bytesToHex(pbkdf2(SHA256, utf8ToBytes('p'), utf8ToBytes('s'), 10, 16));
    expect(a).toBe(b);
  });

  it('rejects a non-positive dkLen', () => {
    expect(() => pbkdf2(SHA256, utf8ToBytes('p'), utf8ToBytes('s'), 1, 0)).toThrow();
  });
});
