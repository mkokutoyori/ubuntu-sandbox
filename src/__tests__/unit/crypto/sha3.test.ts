/**
 * SHA-3 (FIPS 202) : les quatre digests du simulateur donnent les octets de
 * l'implementation de reference de Node (OpenSSL) pour toutes les longueurs
 * d'entree autour des limites de bloc du taux (144, 136, 104 et 72 octets), et
 * les trois vecteurs publies de la norme (entree vide, « abc »).
 *
 * Mesure avant : `sha3.ts` n'existait pas, les 7 cas tombent.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha3 } from '@/crypto/hash/sha3';

const BITS = [224, 256, 384, 512] as const;
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('SHA-3', () => {
  it('SHA3-256 of the empty message is the published vector', () => {
    expect(hex(sha3(256, new Uint8Array(0)))).toBe('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  });

  it('SHA3-256 of "abc" is the published vector', () => {
    expect(hex(sha3(256, new TextEncoder().encode('abc')))).toBe('3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  });

  it('SHA3-512 of "abc" is the published vector', () => {
    expect(hex(sha3(512, new TextEncoder().encode('abc')))).toBe(
      'b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0',
    );
  });

  for (const bits of BITS) {
    it(`SHA3-${bits} agrees with the reference for every length from 0 to 300 bytes`, () => {
      for (let length = 0; length <= 300; length++) {
        const input = Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff);
        expect(hex(sha3(bits, input))).toBe(createHash(`sha3-${bits}`).update(input).digest('hex'));
      }
    });
  }
});
