/**
 * AES-GCM (NIST SP 800-38D) — verified against the official test vectors
 * (Test Cases 1, 2, 3, 4 from the spec), covering empty AAD, full-block and
 * partial-block plaintext, and multi-block AAD. This backs ESP-GCM SAs
 * (RFC 4106), which previously silently fell back to no encryption/no ICV.
 */
import { describe, it, expect } from 'vitest';
import { aesGcmEncrypt, aesGcmDecrypt } from '@/crypto/cipher';
import { hexToBytes, bytesToHex } from '@/crypto/encoding';

describe('AES-GCM — NIST SP 800-38D known-answer tests', () => {
  it('Test Case 1: 128-bit key, empty plaintext, empty AAD', () => {
    const key = hexToBytes('00000000000000000000000000000000'.slice(0, 32));
    const iv = hexToBytes('000000000000000000000000');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, new Uint8Array(0), new Uint8Array(0));
    expect(bytesToHex(ciphertext)).toBe('');
    expect(bytesToHex(tag)).toBe('58e2fccefa7e3061367f1d57a4e7455a');
  });

  it('Test Case 2: 128-bit key, one full block plaintext, empty AAD', () => {
    const key = hexToBytes('00000000000000000000000000000000'.slice(0, 32));
    const iv = hexToBytes('000000000000000000000000');
    const pt = hexToBytes('00000000000000000000000000000000');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, new Uint8Array(0), pt);
    expect(bytesToHex(ciphertext)).toBe('0388dace60b6a392f328c2b971b2fe78');
    expect(bytesToHex(tag)).toBe('ab6e47d42cec13bdf53a67b21257bddf');
  });

  it('Test Case 3: 128-bit key, multi-block plaintext, empty AAD', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    );
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, new Uint8Array(0), pt);
    expect(bytesToHex(ciphertext)).toBe(
      '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091',
    );
    expect(bytesToHex(tag)).toBe('cc15abcc191161501aabab46b8fbac85');
  });

  it('Test Case 4: 128-bit key, partial last block, non-empty AAD', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    ).subarray(0, 60);
    const aad = hexToBytes('feedfacedeadbeeffeedfacedeadbeefabaddad2');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, aad, pt);
    expect(bytesToHex(ciphertext)).toBe(
      '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091',
    );
    expect(bytesToHex(tag)).toBe('5bc94fbc3221a5db94fae95ae7121a47');
  });

  it('decrypt inverts encrypt and recovers the exact plaintext', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes('0102030405060708090a0b0c0d0e0f1011121314');
    const aad = hexToBytes('feedface');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, aad, pt);
    const dec = aesGcmDecrypt(key, iv, aad, ciphertext, tag);
    expect(dec && bytesToHex(dec)).toBe(bytesToHex(pt));
  });

  it('decrypt rejects a tampered ciphertext (bit flip breaks the tag)', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes('0102030405060708090a0b0c0d0e0f1011121314');
    const aad = hexToBytes('feedface');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, aad, pt);
    const tampered = ciphertext.slice();
    tampered[0] ^= 0x01;
    expect(aesGcmDecrypt(key, iv, aad, tampered, tag)).toBeNull();
  });

  it('decrypt rejects a tampered tag', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes('0102030405060708090a0b0c0d0e0f1011121314');
    const aad = hexToBytes('feedface');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, aad, pt);
    const tamperedTag = tag.slice();
    tamperedTag[0] ^= 0x01;
    expect(aesGcmDecrypt(key, iv, aad, ciphertext, tamperedTag)).toBeNull();
  });

  it('decrypt rejects when AAD does not match what was authenticated', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308');
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes('0102030405060708090a0b0c0d0e0f1011121314');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, hexToBytes('feedface'), pt);
    expect(aesGcmDecrypt(key, iv, hexToBytes('deadbeef'), ciphertext, tag)).toBeNull();
  });

  it('256-bit key round-trips', () => {
    const key = hexToBytes('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308'.slice(0, 64));
    const iv = hexToBytes('cafebabefacedbaddecaf888');
    const pt = hexToBytes('48656c6c6f2c20776f726c6421');
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, new Uint8Array(0), pt);
    const dec = aesGcmDecrypt(key, iv, new Uint8Array(0), ciphertext, tag);
    expect(dec && bytesToHex(dec)).toBe(bytesToHex(pt));
  });
});
