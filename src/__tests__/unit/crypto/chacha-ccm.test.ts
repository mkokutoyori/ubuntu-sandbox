/**
 * ChaCha20-Poly1305 (RFC 8439) et AES-CCM (RFC 3610 / SP 800-38C), vérifiés
 * contre `node:crypto` comme oracle indépendant et contre le vecteur
 * d'essai de la RFC 8439 §2.8.2.
 *
 * Avant l'ajout des modules `chacha20Poly1305.ts` et `aesCcm.ts`, tous les
 * cas tombent (modules absents) : aucun témoin.
 */
import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chacha20Poly1305Encrypt, chacha20Poly1305Decrypt, aesCcmEncrypt, aesCcmDecrypt,
} from '@/crypto/cipher';
import { hexToBytes, bytesToHex } from '@/crypto/encoding';

describe('ChaCha20-Poly1305', () => {
  it('vecteur RFC 8439 §2.8.2', () => {
    const key = hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hexToBytes('070000004041424344454647');
    const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7');
    const plaintext = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const { ciphertext, tag } = chacha20Poly1305Encrypt(key, nonce, aad, plaintext);
    expect(bytesToHex(tag)).toBe('1ae10b594f09e26a7e902ecbd0600691');
    expect(bytesToHex(ciphertext.slice(0, 16))).toBe('d31a8d34648e60db7b86afbc53ef7ec2');
  });

  it('égal à node:crypto sur des tailles variées, et refuse un octet modifié', () => {
    for (const size of [0, 1, 15, 16, 17, 63, 64, 65, 200]) {
      const key = randomBytes(32); const nonce = randomBytes(12); const aad = randomBytes(13); const data = randomBytes(size);
      const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad, { plaintextLength: data.length });
      const oracle = Buffer.concat([cipher.update(data), cipher.final()]);
      const oracleTag = cipher.getAuthTag();
      const ours = chacha20Poly1305Encrypt(key, nonce, aad, data);
      expect(Buffer.from(ours.ciphertext).equals(oracle)).toBe(true);
      expect(Buffer.from(ours.tag).equals(oracleTag)).toBe(true);
      expect(chacha20Poly1305Decrypt(key, nonce, aad, ours.ciphertext, ours.tag)).toEqual(new Uint8Array(data));
      const forged = ours.tag.slice(); forged[0] ^= 1;
      expect(chacha20Poly1305Decrypt(key, nonce, aad, ours.ciphertext, forged)).toBeNull();
    }
  });
});

describe('AES-CCM', () => {
  it('un message vide se chiffre et se déchiffre (l\'oracle de node refuse ce cas)', () => {
    const key = randomBytes(16); const nonce = randomBytes(12);
    const sealed = aesCcmEncrypt(key, nonce, new Uint8Array(0), new Uint8Array(0), 16);
    expect(aesCcmDecrypt(key, nonce, new Uint8Array(0), sealed.ciphertext, sealed.tag)).toEqual(new Uint8Array(0));
  });

  for (const [bits, tagLength] of [[128, 16], [128, 8], [256, 16], [256, 8]] as const) {
    it(`AES-${bits}-CCM, étiquette de ${tagLength} octets, égal à node:crypto`, () => {
      for (const size of [1, 15, 16, 17, 100]) {
        const key = randomBytes(bits / 8); const nonce = randomBytes(12); const aad = randomBytes(5); const data = randomBytes(size);
        const cipher = createCipheriv(`aes-${bits}-ccm`, key, nonce, { authTagLength: tagLength });
        cipher.setAAD(aad, { plaintextLength: size });
        const oracle = Buffer.concat([cipher.update(data), cipher.final()]);
        const oracleTag = cipher.getAuthTag();
        const ours = aesCcmEncrypt(key, nonce, aad, data, tagLength);
        expect(Buffer.from(ours.ciphertext).equals(oracle)).toBe(true);
        expect(Buffer.from(ours.tag).equals(oracleTag)).toBe(true);
        expect(aesCcmDecrypt(key, nonce, aad, ours.ciphertext, ours.tag)).toEqual(new Uint8Array(data));
        const decipher = createDecipheriv(`aes-${bits}-ccm`, key, nonce, { authTagLength: tagLength });
        decipher.setAuthTag(Buffer.from(ours.tag)); decipher.setAAD(aad, { plaintextLength: size });
        expect(Buffer.concat([decipher.update(ours.ciphertext), decipher.final()]).equals(Buffer.from(data))).toBe(true);
        const forged = ours.tag.slice(); forged[0] ^= 1;
        expect(aesCcmDecrypt(key, nonce, aad, ours.ciphertext, forged)).toBeNull();
      }
    });
  }
});
