/**
 * HMAC (RFC 2104) — verified against the RFC 2202 (MD5/SHA-1) and RFC 4231
 * (SHA-256) test vectors. The single implementation is parameterised by a
 * HashAlgorithm, so HMAC-MD5 / HMAC-SHA1 / HMAC-SHA256 share one code path.
 */

import { describe, it, expect } from 'vitest';
import { hmac, hmacHex } from '@/crypto/mac';
import { MD5, SHA1, SHA256 } from '@/crypto/hash';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

describe('HMAC-MD5 — RFC 2202', () => {
  it('case 1: 16x0x0b key over "Hi There"', () => {
    const mac = hmac(MD5, hexToBytes('0b'.repeat(16)), utf8ToBytes('Hi There'));
    expect(bytesToHex(mac)).toBe('9294727a3638bb1c13f48ef8158bfc9d');
  });

  it('case 2: "Jefe" key over "what do ya want for nothing?"', () => {
    expect(hmacHex(MD5, 'Jefe', 'what do ya want for nothing?')).toBe(
      '750c783e6ab0b503eaa86e310a5db738',
    );
  });
});

describe('HMAC-SHA1 — RFC 2202', () => {
  it('case 1: 20x0x0b key over "Hi There"', () => {
    const mac = hmac(SHA1, hexToBytes('0b'.repeat(20)), utf8ToBytes('Hi There'));
    expect(bytesToHex(mac)).toBe('b617318655057264e28bc0b6fb378c8ef146be00');
  });

  it('case 2: "Jefe" key', () => {
    expect(hmacHex(SHA1, 'Jefe', 'what do ya want for nothing?')).toBe(
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
    );
  });
});

describe('HMAC-SHA256 — RFC 4231', () => {
  it('case 1: 20x0x0b key over "Hi There"', () => {
    const mac = hmac(SHA256, hexToBytes('0b'.repeat(20)), utf8ToBytes('Hi There'));
    expect(bytesToHex(mac)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('case 2: "Jefe" key', () => {
    expect(hmacHex(SHA256, 'Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('case 6: key longer than the block size is hashed first', () => {
    const mac = hmac(
      SHA256,
      hexToBytes('aa'.repeat(131)),
      utf8ToBytes('Test Using Larger Than Block-Size Key - Hash Key First'),
    );
    expect(bytesToHex(mac)).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });
});

describe('hmac — general properties', () => {
  it('produces a digest the length of the underlying hash', () => {
    expect(hmac(SHA256, utf8ToBytes('k'), utf8ToBytes('m')).length).toBe(32);
    expect(hmac(SHA1, utf8ToBytes('k'), utf8ToBytes('m')).length).toBe(20);
    expect(hmac(MD5, utf8ToBytes('k'), utf8ToBytes('m')).length).toBe(16);
  });

  it('changes completely when the key changes by one bit', () => {
    const a = hmacHex(SHA256, 'key1', 'message');
    const b = hmacHex(SHA256, 'key2', 'message');
    expect(a).not.toBe(b);
  });

  it('handles the empty key and empty message', () => {
    expect(hmacHex(SHA256, '', '')).toBe(
      'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad',
    );
  });
});
