/**
 * Oracle password verifiers — verified against canonical vectors:
 *  - 10g (DES): SCOTT/TIGER -> F894844C34402B67 (openssl-confirmed)
 *  - 11g (S:): hashcat -m 112 example (password "hashcat")
 *  - 12c (T:): hashcat -m 12300 example (password "hashcat")
 */

import { describe, it, expect } from 'vitest';
import { oracle10gHash, oracle11gVerifier, oracle12cVerifier } from '@/crypto/passwords';
import { hexToBytes } from '@/crypto/encoding';

describe('oracle10gHash (legacy DES)', () => {
  it.each([
    ['SCOTT', 'TIGER', 'F894844C34402B67'],
    ['SYSTEM', 'MANAGER', 'D4DF7931AB130E37'],
    ['HR', 'HR', '4C6D73C3E8B0F0DA'],
  ])('hash(%s/%s)', (user, pass, expected) => {
    expect(oracle10gHash(user, pass)).toBe(expected);
  });

  it('uppercases the inputs (case-insensitive like real 10g)', () => {
    expect(oracle10gHash('scott', 'tiger')).toBe('F894844C34402B67');
  });
});

describe('oracle11gVerifier (S: = SHA-1 + salt)', () => {
  it('matches the hashcat -m 112 vector', () => {
    const salt = hexToBytes('38445748184477378130');
    expect(oracle11gVerifier('hashcat', salt)).toBe(
      'S:AC5F1E62D21FD0529428B84D42E8955B0496670338445748184477378130',
    );
  });

  it('produces S: followed by 60 uppercase hex (40 hash + 20 salt)', () => {
    const v = oracle11gVerifier('secret', hexToBytes('00112233445566778899'));
    expect(v).toMatch(/^S:[0-9A-F]{60}$/);
  });
});

describe('oracle12cVerifier (T: = PBKDF2-HMAC-SHA512 + SHA-512 + salt)', () => {
  it('matches the hashcat -m 12300 vector', () => {
    const salt = hexToBytes('34141655046766111066420254008225');
    expect(oracle12cVerifier('hashcat', salt)).toBe(
      'T:78281A9C0CF626BD05EFC4F41B515B61D6C4D95A250CD4A605CA0EF97168D670' +
        'EBCB5673B6F5A2FB9CC4E0C0101E659C0C4E3B9B3BEDA846CD15508E88685A233' +
        '4141655046766111066420254008225',
    );
  });

  it('produces T: followed by 160 uppercase hex (128 hash + 32 salt)', () => {
    const v = oracle12cVerifier('secret', hexToBytes('000102030405060708090a0b0c0d0e0f'));
    expect(v).toMatch(/^T:[0-9A-F]{160}$/);
  });
});
