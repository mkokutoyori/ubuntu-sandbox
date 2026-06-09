/**
 * AES (FIPS-197) — verified against the Appendix C known-answer vectors for
 * 128/192/256-bit keys, plus CBC round-trips. AES is the foundational block
 * cipher (Huawei reversible `cipher`, and future ESP confidentiality).
 */

import { describe, it, expect } from 'vitest';
import {
  aesEncryptBlock, aesDecryptBlock, aesCbcEncrypt, aesCbcDecrypt,
} from '@/crypto/cipher';
import { hexToBytes, bytesToHex, utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';

const PT = '00112233445566778899aabbccddeeff';

describe('AES block cipher — FIPS-197 Appendix C', () => {
  it.each([
    ['000102030405060708090a0b0c0d0e0f', '69c4e0d86a7b0430d8cdb78070b4c55a'],
    ['000102030405060708090a0b0c0d0e0f1011121314151617', 'dda97ca4864cdfe06eaf70a0ec0d7191'],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', '8ea2b7ca516745bfeafc49904b496089'],
  ])('AES-%#: encrypts the KAT block', (keyHex, ctHex) => {
    expect(bytesToHex(aesEncryptBlock(hexToBytes(keyHex), hexToBytes(PT)))).toBe(ctHex);
  });

  it.each([
    '000102030405060708090a0b0c0d0e0f',
    '000102030405060708090a0b0c0d0e0f1011121314151617',
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  ])('decryptBlock inverts encryptBlock (key %s)', (keyHex) => {
    const key = hexToBytes(keyHex);
    const ct = aesEncryptBlock(key, hexToBytes(PT));
    expect(bytesToHex(aesDecryptBlock(key, ct))).toBe(PT);
  });

  it('rejects an invalid key length', () => {
    expect(() => aesEncryptBlock(hexToBytes('0011'), hexToBytes(PT))).toThrow(/key/i);
  });

  it('rejects a non-16-byte block', () => {
    expect(() => aesEncryptBlock(hexToBytes('00'.repeat(16)), hexToBytes('0011'))).toThrow(/block/i);
  });
});

describe('AES-256-CBC', () => {
  const key = new Uint8Array(32); // all-zero key
  const iv = new Uint8Array(16); // all-zero IV

  it('matches the reference ciphertext (PKCS#7)', () => {
    expect(bytesToHex(aesCbcEncrypt(key, iv, utf8ToBytes('Huawei@123')))).toBe(
      'e939ede794690daa76dfa3b23b747f5a',
    );
  });

  it('round-trips arbitrary text', () => {
    for (const text of ['', 'a', 'Huawei@123', 'x'.repeat(16), 'x'.repeat(31), 'unïcode-é-😀']) {
      const ct = aesCbcEncrypt(key, iv, utf8ToBytes(text));
      expect(bytesToUtf8(aesCbcDecrypt(key, iv, ct))).toBe(text);
    }
  });

  it('always pads to a multiple of the block size', () => {
    expect(aesCbcEncrypt(key, iv, utf8ToBytes('1234567890123456')).length % 16).toBe(0);
  });
});
