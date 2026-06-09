/**
 * scrypt (RFC 7914) — verified against the published §12 test vectors. This is
 * the memory-hard KDF behind Cisco type-9 secrets.
 */

import { describe, it, expect } from 'vitest';
import { scrypt, scryptHex } from '@/crypto/kdf';
import { utf8ToBytes, bytesToHex } from '@/crypto/encoding';

describe('scrypt — RFC 7914 §12 vectors', () => {
  it('scrypt("","",N=16,r=1,p=1,dkLen=64)', () => {
    expect(scryptHex('', '', 16, 1, 1, 64)).toBe(
      '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442' +
        'fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
    );
  });

  it('scrypt("password","NaCl",N=1024,r=8,p=16,dkLen=64)', () => {
    expect(scryptHex('password', 'NaCl', 1024, 8, 16, 64)).toBe(
      'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162' +
        '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
    );
  });
});

describe('scrypt — properties', () => {
  it('returns exactly dkLen bytes', () => {
    expect(scrypt(utf8ToBytes('p'), utf8ToBytes('s'), 16, 1, 1, 32).length).toBe(32);
  });

  it('is deterministic', () => {
    const a = bytesToHex(scrypt(utf8ToBytes('p'), utf8ToBytes('s'), 16, 1, 1, 32));
    const b = bytesToHex(scrypt(utf8ToBytes('p'), utf8ToBytes('s'), 16, 1, 1, 32));
    expect(a).toBe(b);
  });

  it('rejects an N that is not a power of two > 1', () => {
    expect(() => scrypt(utf8ToBytes('p'), utf8ToBytes('s'), 15, 1, 1, 32)).toThrow(/power of two/i);
    expect(() => scrypt(utf8ToBytes('p'), utf8ToBytes('s'), 1, 1, 1, 32)).toThrow();
  });
});
