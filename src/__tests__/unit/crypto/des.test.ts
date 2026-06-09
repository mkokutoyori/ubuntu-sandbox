/**
 * DES (FIPS 46-3) — verified against the canonical known-answer vector and
 * an openssl-confirmed CBC round-trip. Needed for the legacy Oracle 10g hash.
 */

import { describe, it, expect } from 'vitest';
import { desEncryptBlock, desDecryptBlock, desCbcEncrypt } from '@/crypto/cipher';
import { hexToBytes, bytesToHex } from '@/crypto/encoding';

describe('DES block cipher', () => {
  it('encrypts the canonical KAT block', () => {
    const ct = desEncryptBlock(hexToBytes('133457799BBCDFF1'), hexToBytes('0123456789ABCDEF'));
    expect(bytesToHex(ct)).toBe('85e813540f0ab405');
  });

  it('decrypts back to the plaintext', () => {
    const key = hexToBytes('133457799BBCDFF1');
    const ct = desEncryptBlock(key, hexToBytes('0123456789ABCDEF'));
    expect(bytesToHex(desDecryptBlock(key, ct))).toBe('0123456789abcdef');
  });

  it('round-trips arbitrary blocks', () => {
    const key = hexToBytes('0123456789ABCDEF');
    for (const pt of ['0000000000000000', 'ffffffffffffffff', 'deadbeefcafe1234']) {
      const ct = desEncryptBlock(key, hexToBytes(pt));
      expect(bytesToHex(desDecryptBlock(key, ct))).toBe(pt);
    }
  });

  it('rejects a non-8-byte key or block', () => {
    expect(() => desEncryptBlock(hexToBytes('0011'), hexToBytes('00'.repeat(8)))).toThrow(/key/i);
    expect(() => desEncryptBlock(hexToBytes('00'.repeat(8)), hexToBytes('0011'))).toThrow(/block/i);
  });
});

describe('DES-CBC (no padding)', () => {
  it('chains blocks (last block matches the Oracle 10g intermediate key)', () => {
    // From the openssl-verified SCOTT/TIGER derivation: CBC of "SCOTTTIGER"
    // (UTF-16BE, zero-padded) under 0x0123456789ABCDEF yields this last block.
    const data = hexToBytes('00530043004f005400540054004900470045005200000000');
    const ct = desCbcEncrypt(hexToBytes('0123456789ABCDEF'), new Uint8Array(8), data);
    expect(bytesToHex(ct.subarray(ct.length - 8))).toBe('926e8facf4ecae88');
  });

  it('requires a positive multiple of 8 bytes', () => {
    expect(() => desCbcEncrypt(new Uint8Array(8), new Uint8Array(8), hexToBytes('0011'))).toThrow();
  });
});
