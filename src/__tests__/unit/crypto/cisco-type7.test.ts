/**
 * Cisco type-7 password encoding (the `password 7 …` / `service
 * password-encryption` scheme). It is a reversible XOR against a fixed
 * vendor key — weak, but it is the genuine format real IOS emits, and the
 * simulator currently shows plaintext where it claims type-7.
 *
 * Vectors below are well-known: `0822455D0A16` and `070C285F4D06` both
 * decode to "cisco" (different salts).
 */

import { describe, it, expect } from 'vitest';
import { encryptType7, decryptType7 } from '@/crypto/passwords';

describe('decryptType7 — canonical vectors', () => {
  it.each([
    ['0822455D0A16', 'cisco'],
    ['070C285F4D06', 'cisco'],
    ['03', ''], // salt 03, no payload
  ])('decrypts %s to %j', (cipher, plain) => {
    expect(decryptType7(cipher)).toBe(plain);
  });

  it('decrypts a longer secret', () => {
    // Encrypt then decrypt guarantees we exercise the exact inverse.
    const cipher = encryptType7('Sup3rSecret!', 11);
    expect(decryptType7(cipher)).toBe('Sup3rSecret!');
  });
});

describe('encryptType7', () => {
  it('reproduces the canonical "cisco" ciphertext with salt 8', () => {
    expect(encryptType7('cisco', 8)).toBe('0822455D0A16');
  });

  it('prefixes the 2-digit zero-padded salt', () => {
    expect(encryptType7('x', 3).startsWith('03')).toBe(true);
    expect(encryptType7('x', 7).startsWith('07')).toBe(true);
  });

  it('emits uppercase hex', () => {
    const cipher = encryptType7('password', 0);
    expect(cipher).toBe(cipher.toUpperCase());
  });

  it('encodes the empty password as just the salt', () => {
    expect(encryptType7('', 0)).toBe('00');
  });

  it('defaults to a deterministic salt when none is given', () => {
    expect(encryptType7('cisco')).toBe(encryptType7('cisco'));
  });
});

describe('round-trip', () => {
  it.each(['a', 'cisco', 'P@ssw0rd', 'with space', '12345', '!#$%^&*()'])(
    'encrypt→decrypt is identity for %j',
    (plain) => {
      for (const salt of [0, 1, 5, 15]) {
        expect(decryptType7(encryptType7(plain, salt))).toBe(plain);
      }
    },
  );
});

describe('error handling', () => {
  it('rejects an odd-length ciphertext', () => {
    expect(() => decryptType7('082')).toThrow();
  });

  it('rejects a ciphertext shorter than the salt prefix', () => {
    expect(() => decryptType7('0')).toThrow();
  });

  it('rejects non-hex payloads', () => {
    expect(() => decryptType7('08ZZ')).toThrow();
  });

  it('rejects a salt outside the key range', () => {
    expect(() => encryptType7('x', 99)).toThrow(/salt/i);
  });
});
