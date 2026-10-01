/**
 * RSASSA-PSS (RFC 8017 §8.1, §9.1) contre `node:crypto` : une signature
 * produite ici se vérifie dans node, et inversement. Modules de 1024 et
 * 2048 bits, SHA-256/384/512, sel de la taille du condensé (RFC 8446
 * §4.2.3 l'impose pour rsa_pss_rsae_*).
 *
 * Avant l'ajout de `pss.ts` tous les cas tombent (module absent) : aucun
 * témoin.
 */
import { describe, it, expect } from 'vitest';
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, constants } from 'node:crypto';
import { generateRsaKeyPair, rsaPssSign, rsaPssVerify } from '@/crypto/rsa';
import { modInverse } from '@/crypto/rsa/rsa';
import { SHA256, SHA384, SHA512 } from '@/crypto/hash';

function jwk(n: bigint, e: bigint, extra: Record<string, string> = {}) {
  const b64 = (v: bigint) => Buffer.from(v.toString(16).padStart(Math.ceil(v.toString(16).length / 2) * 2, '0'), 'hex').toString('base64url');
  return { kty: 'RSA', n: b64(n), e: b64(e), ...extra };
}

describe('RSASSA-PSS', () => {
  for (const bits of [1024, 2048]) {
    for (const [name, hash, digest] of [['sha256', SHA256, 'sha256'], ['sha384', SHA384, 'sha384'], ['sha512', SHA512, 'sha512']] as const) {
      if (bits === 1024 && name === 'sha512') continue;
      it(`${bits} bits, ${name} : signé ici → vérifié par node, et inversement`, () => {
        const { publicKey, privateKey } = generateRsaKeyPair(bits);
        const message = Buffer.from('CertificateVerify content');
        const ours = rsaPssSign(privateKey, message, hash);
        const nodePublic = createPublicKey({ key: jwk(publicKey.n, publicKey.e), format: 'jwk' });
        expect(nodeVerify(digest, message, { key: nodePublic, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: hash.digestSize }, Buffer.from(ours))).toBe(true);

        const p = privateKey.p!; const q = privateKey.q!;
        const nodePrivate = createPrivateKey({
          key: jwk(publicKey.n, publicKey.e, {
            d: jwk(privateKey.d, 1n).n, p: jwk(p, 1n).n, q: jwk(q, 1n).n,
            dp: jwk(privateKey.d % (p - 1n), 1n).n, dq: jwk(privateKey.d % (q - 1n), 1n).n, qi: jwk(modInverse(q, p), 1n).n,
          }),
          format: 'jwk',
        });
        const theirs = nodeSign(digest, message, { key: nodePrivate, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: hash.digestSize });
        expect(rsaPssVerify(publicKey, message, new Uint8Array(theirs), hash)).toBe(true);
        expect(rsaPssVerify(publicKey, Buffer.from('other'), new Uint8Array(theirs), hash)).toBe(false);
        const forged = Uint8Array.from(ours); forged[forged.length - 1] ^= 1;
        expect(rsaPssVerify(publicKey, message, forged, hash)).toBe(false);
      });
    }
  }

  it('un module de 512 bits ne tient pas dans RSASSA-PSS/SHA-256 (hLen + sLen + 2 = 66 octets > 64)', () => {
    const { privateKey } = generateRsaKeyPair(512);
    expect(() => rsaPssSign(privateKey, new Uint8Array(1), SHA256)).toThrow('modulus too small');
  });
});
