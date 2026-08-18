/**
 * IKE calcule un VRAI Diffie-Hellman, et 3DES se dechiffre.
 *
 * Ce que la mesure a trouve avant d'ecrire une ligne : le moteur IKE
 * NEGOCIAIT un groupe Diffie-Hellman, l'appariait entre les deux pairs,
 * l'affichait dans `show crypto isakmp sa detail` — et ne le CALCULAIT
 * pour aucun groupe. Le materiel de cle venait du secret partage seul,
 * a travers un vrai PRF+ IKEv2 (HMAC-SHA256) ; le groupe etait donc un
 * critere range, apparie, et jamais evalue en tant que calcul.
 *
 * Consequence pratique : deux pairs qui partagent la PSK derivaient les
 * memes cles SANS echange de cles. La propriete que Diffie-Hellman
 * existe pour donner — un secret que seuls les deux pairs peuvent
 * calculer, meme pour qui a tout ecoute — etait absente.
 *
 * Les nombres premiers viennent des RFC 2409 (groupes 1 et 2) et
 * RFC 3526 (5, 14, 15, 16), EXTRAITS du texte des RFC et non recopies
 * de memoire, puis verifies : longueur en bits exacte, encadrement par
 * 64 bits a un, `p mod 24 == 23` (la propriete qui fait de 2 un
 * generateur) et test de primalite.
 *
 * 3DES : `desCbcDecrypt` n'existait pas — seul `desCbcEncrypt`. Un
 * tunnel negocie dessus aurait chiffre ce qu'il ne savait pas relire.
 * Le mode CBC est ecrit, le triple DES EDE avec, et ESP les APPLIQUE :
 * avant, un SA annonce en 3DES-CBC chiffrait en AES.
 */

import { describe, it, expect } from 'vitest';
import {
  generateIkeKeyShare, ikeSharedSecret, implementedIkeGroups,
  isImplementedIkeGroup,
} from '@/network/ipsec/IkeKeyExchange';
import { MODP_GROUPS, generateModpKeyPair, modpSharedSecret } from '@/crypto/dh/modp';
import {
  desCbcEncrypt, desCbcDecrypt, tripleDesCbcEncrypt, tripleDesCbcDecrypt,
} from '@/crypto/cipher/des';

const fromHex = (s: string) =>
  new Uint8Array((s.match(/../g) ?? []).map(x => Number.parseInt(x, 16)));
const toHex = (b: Uint8Array) =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const ascii = (s: string) => new Uint8Array([...s].map(c => c.charCodeAt(0)));

describe('les nombres premiers sont ceux des RFC', () => {
  it.each([[1, 768], [2, 1024], [5, 1536], [14, 2048], [15, 3072], [16, 4096]])(
    'le groupe %i fait %i bits', (group, bits) => {
      expect(MODP_GROUPS.get(group)?.prime.toString(2).length).toBe(bits);
    });

  it.each([1, 2, 5, 14, 15, 16])(
    'le groupe %i est encadre par 64 bits a un, et 2 en est generateur', (group) => {
      const prime = MODP_GROUPS.get(group)!.prime;
      const hex = prime.toString(16).toUpperCase();

      expect(hex.slice(0, 16)).toBe('F'.repeat(16));
      expect(hex.slice(-16)).toBe('F'.repeat(16));
      expect(prime % 24n).toBe(23n);
      expect(MODP_GROUPS.get(group)!.generator).toBe(2n);
    });

  it.each([1, 2, 5, 14])('le groupe %i passe le test de Fermat en base 2', (group) => {
    const prime = MODP_GROUPS.get(group)!.prime;

    expect(modPowLocal(2n, prime - 1n, prime)).toBe(1n);
  });
});

describe('l`echange de cles est reel', () => {
  it('les groupes implementes sont ceux qu`on calcule vraiment', () => {
    expect(implementedIkeGroups()).toEqual([1, 2, 5, 14, 15, 16, 19, 31]);
  });

  it.each([1, 2, 5, 14, 15, 16, 19, 31])(
    'groupe %i : les deux pairs obtiennent le MEME secret', (group) => {
      const alice = generateIkeKeyShare(group)!;
      const bob = generateIkeKeyShare(group)!;

      const fromAlice = ikeSharedSecret(alice.pair, bob.payload);
      const fromBob = ikeSharedSecret(bob.pair, alice.payload);

      expect(fromAlice).not.toBeNull();
      expect(fromAlice!.length).toBeGreaterThan(0);
      expect(fromAlice).toBe(fromBob);
    });

  it.each([1, 2, 5, 14, 19, 31])(
    'groupe %i : un TIERS qui a tout ecoute obtient autre chose', (group) => {
      const alice = generateIkeKeyShare(group)!;
      const bob = generateIkeKeyShare(group)!;
      const espion = generateIkeKeyShare(group)!;

      const partage = ikeSharedSecret(alice.pair, bob.payload);
      const devine = ikeSharedSecret(espion.pair, alice.payload);

      expect(devine).not.toBe(partage);
    });

  it('deux echanges successifs ne donnent pas le meme secret', () => {
    const first = ikeSharedSecret(
      generateIkeKeyShare(14)!.pair, generateIkeKeyShare(14)!.payload);
    const second = ikeSharedSecret(
      generateIkeKeyShare(14)!.pair, generateIkeKeyShare(14)!.payload);

    expect(first).not.toBe(second);
  });

  it('une part publique hors bornes est refusee', () => {
    const own = generateModpKeyPair(MODP_GROUPS.get(14)!);

    expect(modpSharedSecret(own, 1n)).toBeNull();
    expect(modpSharedSecret(own, MODP_GROUPS.get(14)!.prime - 1n)).toBeNull();
  });

  it('un groupe sans implementation ne rend aucune part', () => {
    expect(isImplementedIkeGroup(18)).toBe(false);
    expect(generateIkeKeyShare(18)).toBeNull();
  });

  it('un groupe discordant ne produit aucun secret', () => {
    const alice = generateIkeKeyShare(14)!;
    const bob = generateIkeKeyShare(19)!;

    expect(ikeSharedSecret(alice.pair, bob.payload)).toBeNull();
  });
});

describe('DES et 3DES', () => {
  it('le vecteur FIPS 81 en CBC est reproduit', () => {
    const key = fromHex('0123456789abcdef');
    const iv = fromHex('1234567890abcdef');

    const cipher = desCbcEncrypt(key, iv, ascii('Now is the time for all '));

    expect(toHex(cipher)).toBe('e5c7cdde872bf27c43e934008c389c0f683788499a7c05f6');
  });

  it('et il se dechiffre', () => {
    const key = fromHex('0123456789abcdef');
    const iv = fromHex('1234567890abcdef');
    const clair = ascii('Now is the time for all ');

    expect(toHex(desCbcDecrypt(key, iv, desCbcEncrypt(key, iv, clair))))
      .toBe(toHex(clair));
  });

  it('3DES a trois cles identiques SE REDUIT a DES', () => {
    const key = fromHex('0123456789abcdef');
    const triple = new Uint8Array([...key, ...key, ...key]);
    const iv = fromHex('1234567890abcdef');
    const clair = ascii('Now is the time for all ');

    expect(toHex(tripleDesCbcEncrypt(triple, iv, clair)))
      .toBe(toHex(desCbcEncrypt(key, iv, clair)));
  });

  it('3DES a trois cles distinctes fait un aller-retour', () => {
    const triple = fromHex('0123456789abcdef23456789abcdef0145678901234567ab');
    const iv = fromHex('1234567890abcdef');
    const clair = ascii('Now is the time for all ');

    expect(toHex(tripleDesCbcDecrypt(triple, iv, tripleDesCbcEncrypt(triple, iv, clair))))
      .toBe(toHex(clair));
  });

  it('et il ne rend PAS le meme chiffre que DES seul', () => {
    const triple = fromHex('0123456789abcdef23456789abcdef0145678901234567ab');
    const iv = fromHex('1234567890abcdef');
    const clair = ascii('Now is the time for all ');

    expect(toHex(tripleDesCbcEncrypt(triple, iv, clair)))
      .not.toBe(toHex(desCbcEncrypt(fromHex('0123456789abcdef'), iv, clair)));
  });
});

function modPowLocal(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}
