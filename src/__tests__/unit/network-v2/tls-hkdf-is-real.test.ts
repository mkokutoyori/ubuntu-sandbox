/**
 * HKDF-SHA256 réel — confronté aux vecteurs de la RFC 5869.
 *
 * C'est ce qui sépare une implémentation d'une invention plausible. Le
 * calendrier de clés de TLS 1.3 dérivait jusqu'ici tout son arbre avec
 * `simulatedDigest` : les secrets divergeaient bien quand ils devaient
 * diverger — l'arbre du §7.1 est une propriété de STRUCTURE, vérifiable
 * sans cryptographie — mais rien ne pouvait être comparé à une autre
 * implémentation, donc rien ne pouvait être faux de façon détectable.
 *
 * Les vecteurs ci-dessous viennent de l'annexe A de la RFC 5869. Le HMAC
 * qu'ils exercent était déjà réel (`src/crypto/mac`, RFC 2104) ; il ne
 * manquait que les trente lignes qui en font un KDF.
 */

import { describe, it, expect } from 'vitest';
import { hkdfExtract, hkdfExpand, hkdfLabel, HASH_LEN } from '@/network/tls/hkdf';
import {
  extractSecret, expandLabel, transcriptHash, computeFinished, ZERO_IKM,
} from '@/network/tls/keySchedule';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

const octets = (hex: string): Uint8Array => hexToBytes(hex);

describe('RFC 5869 annexe A — les vecteurs officiels', () => {
  it('cas 1 : SHA-256, entrées et sel courts', () => {
    const ikm = octets('0b'.repeat(22));
    const salt = octets('000102030405060708090a0b0c');
    const info = octets('f0f1f2f3f4f5f6f7f8f9');

    const prk = hkdfExtract(salt, ikm);
    expect(bytesToHex(prk))
      .toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');

    expect(bytesToHex(hkdfExpand(prk, info, 42)))
      .toBe('3cb25f25faacd57a90434f64d0362f2a'
        + '2d2d0a90cf1a5a4c5db02d56ecc4c5bf'
        + '34007208d5b887185865');
  });

  it('cas 2 : entrées longues, plusieurs tours d\'expansion', () => {
    const ikm = octets(Array.from({ length: 80 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
    const salt = octets(Array.from({ length: 80 }, (_, i) => (0x60 + i).toString(16).padStart(2, '0')).join(''));
    const info = octets(Array.from({ length: 80 }, (_, i) => (0xb0 + i).toString(16).padStart(2, '0')).join(''));

    const prk = hkdfExtract(salt, ikm);
    expect(bytesToHex(prk))
      .toBe('06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244');

    // 82 octets : le compteur de `HKDF-Expand` passe par trois tours, ce
    // que le cas 1 n'exerce pas.
    expect(bytesToHex(hkdfExpand(prk, info, 82)))
      .toBe('b11e398dc80327a1c8e7f78c596a4934'
        + '4f012eda2d4efad8a050cc4c19afa97c'
        + '59045a99cac7827271cb41c65e590e09'
        + 'da3275600c2f09b8367793a9aca3db71'
        + 'cc30c58179ec3e87c14c01d5c1f3434f'
        + '1d87');
  });

  it('cas 3 : sel et info vides — le cas que TLS utilise le plus', () => {
    const ikm = octets('0b'.repeat(22));

    const prk = hkdfExtract(new Uint8Array(0), ikm);
    expect(bytesToHex(prk))
      .toBe('19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04');

    expect(bytesToHex(hkdfExpand(prk, new Uint8Array(0), 42)))
      .toBe('8da4e775a563c18f715f802a063c5a31'
        + 'b8a11f5c5ee1879ec3454e5f3c738d2d'
        + '9d201395faa4b61a96c8');
  });
});

describe('RFC 8446 §7.1 — la structure HkdfLabel', () => {
  /**
   * La forme compte, et elle ne se verrait pas entre deux implémentations
   * identiques : deux longueurs sur un octet, un préfixe `tls13 `, une
   * longueur totale sur deux octets en gros-boutien.
   */
  it('sérialise longueur, étiquette préfixée et contexte, chacun avec sa longueur', () => {
    const l = hkdfLabel(32, 'derived', new Uint8Array(0));

    expect(l[0]).toBe(0x00);
    expect(l[1]).toBe(32);
    expect(l[2]).toBe('tls13 derived'.length);
    expect(new TextDecoder().decode(l.subarray(3, 3 + 'tls13 derived'.length)))
      .toBe('tls13 derived');
    expect(l[l.length - 1]).toBe(0); // contexte vide, longueur nulle
  });

  it('le contexte suit sa propre longueur', () => {
    const ctx = utf8ToBytes('abc');
    const l = hkdfLabel(32, 'x', ctx);
    expect(l[l.length - 4]).toBe(3);
    expect(new TextDecoder().decode(l.subarray(l.length - 3))).toBe('abc');
  });

  it('une longueur de sortie de 16 ne donne pas les 16 premiers octets de celle de 32', () => {
    // Parce que la longueur entre DANS l'étiquette : c'est ce qui empêche
    // une clé de 16 octets d'être un préfixe de la clé de 32.
    const court = hkdfExpand(octets('0b'.repeat(32)), hkdfLabel(16, 'key', new Uint8Array(0)), 16);
    const long = hkdfExpand(octets('0b'.repeat(32)), hkdfLabel(32, 'key', new Uint8Array(0)), 32);
    expect(bytesToHex(court)).not.toBe(bytesToHex(long).slice(0, 32));
  });
});

describe('le calendrier de clés en sort réel', () => {
  it('les secrets font exactement Hash.length octets', () => {
    expect(extractSecret('', ZERO_IKM)).toHaveLength(HASH_LEN * 2);
    expect(expandLabel(extractSecret('', ZERO_IKM), 'derived', '')).toHaveLength(HASH_LEN * 2);
  });

  it('le « 0 » de la RFC fait bien 32 octets nuls', () => {
    // Il en portait seize : sans conséquence tant que la dérivation était
    // simulée, faux dès qu'elle ne l'est plus.
    expect(ZERO_IKM).toBe('00'.repeat(HASH_LEN));
  });

  it('la transcription est un vrai SHA-256, sensible à l\'ordre', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    expect(transcriptHash([a, b])).toHaveLength(HASH_LEN * 2);
    expect(transcriptHash([a, b])).not.toBe(transcriptHash([b, a]));
    // Concaténation, pas séparateur : la RFC hache les messages bout à
    // bout, et le résultat doit donc être celui d'un seul message.
    expect(transcriptHash([a, b])).toBe(transcriptHash([new Uint8Array([1, 2, 3, 4, 5])]));
  });

  it('le Finished passe par sa finished_key, comme le §4.4.4 le demande', () => {
    const secret = extractSecret('sel', 'materiel');
    const v = computeFinished(secret, transcriptHash([new Uint8Array([9])]));
    expect(v).toHaveLength(HASH_LEN * 2);
    expect(v).not.toBe(computeFinished(secret, transcriptHash([new Uint8Array([8])])));
    expect(v).not.toBe(computeFinished(extractSecret('sel', 'autre'), transcriptHash([new Uint8Array([9])])));
  });
});
