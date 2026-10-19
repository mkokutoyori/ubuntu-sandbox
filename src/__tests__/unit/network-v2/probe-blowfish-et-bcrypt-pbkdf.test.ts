/**
 * Sonde de Blowfish et de bcrypt_pbkdf (la derivation de cle des fichiers prives OpenSSH).
 * Les tables initiales de Blowfish sont calculees a partir de pi (aucune table recopiee) ;
 * les vecteurs bcrypt_pbkdf viennent du module python bcrypt, independant de ce depot.
 * Avant la correction : 0 cas sur 5 (ni Blowfish ni bcrypt_pbkdf n'existaient).
 */
import { describe, it, expect } from 'vitest';
import { Blowfish } from '@/crypto/cipher/blowfish';
import { bcryptPbkdf } from '@/crypto/kdf/bcryptPbkdf';
import { hexToBytes, bytesToHex } from '@/crypto/encoding';

describe('Blowfish', () => {
  it('encrypts the all-zero block under the all-zero key to the published test vector', () => {
    const cipher = Blowfish.withKey(new Uint8Array(8));
    const block = new Uint32Array(2);
    cipher.encipher(block);
    expect(block[0].toString(16).padStart(8, '0') + block[1].toString(16).padStart(8, '0')).toBe('4ef997456198dd78');
  });

  it('encrypts a second published vector (key FEDCBA9876543210)', () => {
    const cipher = Blowfish.withKey(hexToBytes('fedcba9876543210'));
    const block = new Uint32Array([0x01234567, 0x89abcdef]);
    cipher.encipher(block);
    expect(block[0].toString(16).padStart(8, '0') + block[1].toString(16).padStart(8, '0')).toBe('0aceab0fc6a0a28d');
  });
});

const VECTORS = [
  { password: '70617373776f7264', salt: '73616c74', length: 32, rounds: 4, expected: '5bbf0cc293587f1c3635555c27796598d47e579071bf427e9d8fbe842aba34d9' },
  { password: '70617373776f7264', salt: '000102030405060708090a0b0c0d0e0f', length: 48, rounds: 16, expected: '3bf00d79f63fbfe0da0fb0fdf469a1a144b39eb1c527e3e7e7acc2639b77a272851b705e76d964c0277a199a494ca980' },
  { password: '61206d756368206c6f6e676572207061737370687261736520c3a9', salt: '6465666768696a6b6c6d6e6f70717273', length: 80, rounds: 3, expected: 'c3b18fb453a699d307dbe09a889866af2bbf33b2d72fa604c7588d350176cefef6440e995cb097ecb3843121a63b0006fdf049d73e1c446fee7a50218f7deedf443d30929d3e9f3d0f28458b5df7cca0' }
];

describe('bcrypt_pbkdf', () => {
  it.each(VECTORS)('derives $length bytes in $rounds rounds exactly like the reference implementation', (vector) => {
    const derived = bcryptPbkdf(hexToBytes(vector.password), hexToBytes(vector.salt), vector.length, vector.rounds);
    expect(bytesToHex(derived)).toBe(vector.expected);
  });
});
