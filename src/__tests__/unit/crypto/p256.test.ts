/**
 * ECDSA sur P-256 — confronté aux vecteurs de la RFC 6979 §A.2.5.
 *
 * C'était le dernier chemin simulé de `PkiKeyPair` : la « signature »
 * ECDSA était un condensé FNV-1a que la seule clé publique suffisait à
 * recalculer. Les vecteurs ci-dessous sont ce qui distingue une
 * implémentation d'une invention plausible — une arithmétique de courbe
 * écrite de mémoire donne des résultats parfaitement déterministes et
 * parfaitement faux.
 */

import { describe, it, expect } from 'vitest';
import {
  p256Sign, p256Verify, p256PublicKey, isOnCurve, signatureToHex, p256Ecdh,
  materialToP256Public, materialToP256Private, p256PublicPartOf,
  p256PrivateToMaterial, p256PublicToMaterial, P256_ORDER,
} from '@/crypto/ecc';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { utf8ToBytes, bytesToHex } from '@/crypto/encoding';

/** La clé privée de l'annexe A.2.5. */
const D = 0xc9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721n;

const hex = (n: bigint) => n.toString(16).padStart(64, '0').toUpperCase();

describe('RFC 6979 §A.2.5 — la clé publique', () => {
  it('est celle que la RFC donne', () => {
    const q = p256PublicKey(D);
    expect(hex(q.x)).toBe('60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6');
    expect(hex(q.y)).toBe('7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299');
  });

  it('et elle est sur la courbe', () => {
    expect(isOnCurve(p256PublicKey(D))).toBe(true);
  });
});

describe('RFC 6979 §A.2.5 — les signatures, avec SHA-256', () => {
  it('« sample »', () => {
    const { r, s } = p256Sign(D, utf8ToBytes('sample'));
    expect(hex(r)).toBe('EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716');
    expect(hex(s)).toBe('F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8');
  });

  it('« test »', () => {
    const { r, s } = p256Sign(D, utf8ToBytes('test'));
    expect(hex(r)).toBe('F1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367');
    expect(hex(s)).toBe('019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083');
  });

  /**
   * Le `k` déterministe n'est pas une commodité de test. Un ECDSA à `k`
   * tiré au hasard livre la clé privée ENTIÈRE dès que deux signatures
   * le réutilisent ; la RFC 6979 supprime la question en dérivant `k` du
   * message et de la clé.
   */
  it('deux signatures du même message sont identiques', () => {
    expect(signatureToHex(p256Sign(D, utf8ToBytes('sample'))))
      .toBe(signatureToHex(p256Sign(D, utf8ToBytes('sample'))));
  });

  it('et deux messages différents ne partagent pas leur r', () => {
    // r vient de k·G : un r commun signalerait un k réutilisé.
    expect(p256Sign(D, utf8ToBytes('sample')).r).not.toBe(p256Sign(D, utf8ToBytes('test')).r);
  });
});

describe('ce que la vérification refuse', () => {
  const q = p256PublicKey(D);

  it('accepte la vraie signature', () => {
    expect(p256Verify(q, utf8ToBytes('sample'), p256Sign(D, utf8ToBytes('sample')))).toBe(true);
  });

  it('refuse un autre message', () => {
    expect(p256Verify(q, utf8ToBytes('autre'), p256Sign(D, utf8ToBytes('sample')))).toBe(false);
  });

  it('refuse une autre clé', () => {
    expect(p256Verify(p256PublicKey(D + 1n), utf8ToBytes('sample'), p256Sign(D, utf8ToBytes('sample'))))
      .toBe(false);
  });

  it('refuse un s hors de [1, n-1]', () => {
    const sig = p256Sign(D, utf8ToBytes('sample'));
    expect(p256Verify(q, utf8ToBytes('sample'), { r: sig.r, s: 0n })).toBe(false);
    expect(p256Verify(q, utf8ToBytes('sample'), { r: sig.r, s: P256_ORDER })).toBe(false);
  });

  /**
   * Un point qui n'est pas sur la courbe doit être rejeté AVANT tout
   * calcul : c'est l'attaque par courbe invalide, où l'attaquant apprend
   * le scalaire du pair en le faisant travailler sur une courbe voisine
   * d'ordre lisse.
   */
  it('refuse une clé publique hors courbe', () => {
    expect(isOnCurve({ x: q.x, y: q.y + 1n })).toBe(false);
    expect(p256Verify({ x: q.x, y: q.y + 1n }, utf8ToBytes('sample'), p256Sign(D, utf8ToBytes('sample'))))
      .toBe(false);
  });
});

describe('la sérialisation', () => {
  it('encode le point non compressé de la SEC 1', () => {
    const q = p256PublicKey(D);
    const m = p256PublicToMaterial(q);
    expect(m.startsWith('ec-pub:04')).toBe(true);
    expect(m.slice('ec-pub:'.length)).toHaveLength(130); // 04 + X + Y
    expect(materialToP256Public(m)).toEqual(q);
  });

  it('et la moitié publique ne porte pas le scalaire privé', () => {
    const q = p256PublicKey(D);
    const priv = p256PrivateToMaterial(D, q);
    expect(materialToP256Private(priv)).toBe(D);
    expect(p256PublicPartOf(priv)).toBe(p256PublicToMaterial(q));
    expect(materialToP256Private(p256PublicPartOf(priv))).toBeNull();
  });
});

describe('PkiKeyPair passe par ce moteur', () => {
  it('signe et vérifie une clé ECDSA pour de vrai', () => {
    const kp = PkiKeyPair.generate('ecdsa');
    expect(kp.publicKey.material.startsWith('ec-pub:')).toBe(true);
    const sig = PkiKeyPair.sign(kp.privateKey, 'contenu');
    expect(sig.startsWith('ecdsa:')).toBe(true);
    expect(PkiKeyPair.verify(kp.publicKey, 'contenu', sig)).toBe(true);
    expect(PkiKeyPair.verify(kp.publicKey, 'autre contenu', sig)).toBe(false);
  });

  it('une clé ECDSA ne vérifie pas la signature d\'une autre', () => {
    const a = PkiKeyPair.generate('ecdsa');
    const b = PkiKeyPair.generate('ecdsa');
    expect(PkiKeyPair.verify(a.publicKey, 'x', PkiKeyPair.sign(b.privateKey, 'x'))).toBe(false);
  });

  it('et une signature RSA n\'est pas acceptée par une clé ECDSA, ni l\'inverse', () => {
    const ec = PkiKeyPair.generate('ecdsa');
    const rsa = PkiKeyPair.generate('rsa', 512);
    expect(PkiKeyPair.verify(ec.publicKey, 'x', PkiKeyPair.sign(rsa.privateKey, 'x'))).toBe(false);
    expect(PkiKeyPair.verify(rsa.publicKey, 'x', PkiKeyPair.sign(ec.privateKey, 'x'))).toBe(false);
  });

  it('deux clés ECDSA tirées de suite sont différentes', () => {
    expect(PkiKeyPair.generate('ecdsa').publicKey.material)
      .not.toBe(PkiKeyPair.generate('ecdsa').publicKey.material);
  });
});

describe('ECDH sur P-256 — le groupe secp256r1 de TLS', () => {
  const da = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn % P256_ORDER;
  const db = 0x0fedcba098765432100fedcba098765432100fedcba09876543210fedcba09876n % P256_ORDER;

  it('les deux bouts arrivent au même secret', () => {
    const sa = p256Ecdh(da, p256PublicKey(db));
    const sb = p256Ecdh(db, p256PublicKey(da));
    expect(sa).not.toBeNull();
    expect(bytesToHex(sa!)).toBe(bytesToHex(sb!));
  });

  /**
   * Ce que le condensé qu'il remplace ne pouvait pas offrir : ce condensé
   * n'était QUE la fonction des valeurs publiques, si bien qu'un témoin
   * de la poignée de main l'obtenait aussi. Le test ne prouve évidemment
   * pas la difficulté du problème ; il pose que le secret n'est aucune
   * des deux abscisses publiques, ce qui suffit à distinguer les deux
   * situations.
   */
  it('le secret n\'est aucune des deux valeurs publiques', () => {
    const qa = p256PublicKey(da);
    const qb = p256PublicKey(db);
    const partage = bytesToHex(p256Ecdh(da, qb)!);
    expect(partage).not.toBe(qa.x.toString(16).padStart(64, '0'));
    expect(partage).not.toBe(qb.x.toString(16).padStart(64, '0'));
  });

  it('et deux paires différentes ne partagent pas le même secret', () => {
    const dc = 0x00aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899n % P256_ORDER;
    expect(bytesToHex(p256Ecdh(da, p256PublicKey(db))!))
      .not.toBe(bytesToHex(p256Ecdh(da, p256PublicKey(dc))!));
  });

  it('refuse un point qui n\'est pas sur la courbe', () => {
    const q = p256PublicKey(D);
    expect(p256Ecdh(D, { x: q.x, y: q.y + 1n })).toBeNull();
  });
});
