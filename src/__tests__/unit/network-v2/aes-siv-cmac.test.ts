/**
 * AES-CMAC (RFC 4493) and AES-SIV (RFC 5297), the primitive behind
 * AEAD_AES_SIV_CMAC_256 of NTS (RFC 8915). Two references: the RFC's own
 * vectors, and 60 random cases produced by OpenSSL 3.0.13 through
 * python-cryptography (scripts/oracle/record_aes_siv.py), with key sizes
 * 256, 384 and 512 bits, 0 to 3 associated-data strings and plaintexts of
 * every length class around the block size.
 *
 * Measured against nothing: the primitives did not exist, so every case
 * falls without them. The empty-message CMAC vector is the witness for the
 * subkey derivation shared by all the others.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { aesCmac } from '@/crypto/mac';
import { aesSivEncrypt, aesSivDecrypt } from '@/crypto/cipher';

const hex = (text: string): Uint8Array => Uint8Array.from(text.replace(/\s+/g, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const text = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/aes-siv-cmac-openssl.json', import.meta.url), 'utf8')) as {
  siv: { key: string; ad: string[]; pt: string; ct: string }[];
  cmac: { key: string; msg: string; mac: string }[];
};

describe('AES-CMAC', () => {
  const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
  it('RFC 4493 vectors', () => {
    expect(text(aesCmac(key, hex('')))).toBe('bb1d6929e95937287fa37d129b756746');
    expect(text(aesCmac(key, hex('6bc1bee22e409f96e93d7e117393172a')))).toBe('070a16b46b4d4144f79bdd9dd04a287c');
    expect(text(aesCmac(key, hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'))))
      .toBe('dfa66747de9ae63030ca32611497c827');
  });
  fixture.cmac.forEach((c, i) => it(`OpenSSL case ${i}`, () => {
    expect(text(aesCmac(hex(c.key), hex(c.msg)))).toBe(c.mac);
  }));
});

describe('AES-SIV', () => {
  it('RFC 5297 A.1 deterministic authenticated encryption', () => {
    const key = hex('fffefdfc fbfaf9f8 f7f6f5f4 f3f2f1f0 f0f1f2f3 f4f5f6f7 f8f9fafb fcfdfeff');
    const ad = hex('10111213 14151617 18191a1b 1c1d1e1f 20212223 24252627');
    const plaintext = hex('112233445566778899aabbccddee');
    const sealed = aesSivEncrypt(key, [ad], plaintext);
    expect(text(sealed)).toBe('85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c');
    expect(aesSivDecrypt(key, [ad], sealed)).toEqual(plaintext);
  });
  it('RFC 5297 A.2 nonce-based authenticated encryption', () => {
    const key = hex('7f7e7d7c 7b7a7978 77767574 73727170 40414243 44454647 48494a4b 4c4d4e4f');
    const ad1 = hex('00112233 44556677 8899aabb ccddeeff deaddada deaddada ffeeddcc bbaa9988 77665544 33221100');
    const ad2 = hex('10203040 50607080 90a0');
    const nonce = hex('09f91102 9d74e35b d84156c5 635688c0');
    const plaintext = hex('74686973 20697320 736f6d65 20706c61 696e7465 78742074 6f20656e 63727970 74207573 696e6720 5349562d 414553');
    const sealed = aesSivEncrypt(key, [ad1, ad2, nonce], plaintext);
    expect(text(sealed)).toBe('7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d');
  });
  fixture.siv.forEach((c, i) => it(`OpenSSL case ${i}: ${c.key.length * 4}-bit key, ${c.ad.length} AD, ${c.pt.length / 2} bytes`, () => {
    const sealed = aesSivEncrypt(hex(c.key), c.ad.map(hex), hex(c.pt));
    expect(text(sealed)).toBe(c.ct);
    expect(text(aesSivDecrypt(hex(c.key), c.ad.map(hex), sealed)!)).toBe(c.pt);
  }));
  it('rejects a modified ciphertext, associated data or key', () => {
    const key = hex('fffefdfc fbfaf9f8 f7f6f5f4 f3f2f1f0 f0f1f2f3 f4f5f6f7 f8f9fafb fcfdfeff');
    const sealed = aesSivEncrypt(key, [hex('0102')], hex('aabbcc'));
    const tampered = sealed.slice(); tampered[tampered.length - 1] ^= 1;
    expect(aesSivDecrypt(key, [hex('0102')], tampered)).toBeNull();
    expect(aesSivDecrypt(key, [hex('0103')], sealed)).toBeNull();
    expect(aesSivDecrypt(hex('00'.repeat(32)), [hex('0102')], sealed)).toBeNull();
  });
});
