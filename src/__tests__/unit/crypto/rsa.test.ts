/**
 * RSA réel — RFC 8017.
 *
 * Ce que remplace ce moteur : une clé était `pub:<graine>` /
 * `priv:<graine>`, la MÊME graine des deux côtés, et `verify()`
 * reconstituait le matériel privé depuis le public pour recalculer la
 * signature. Quiconque tenait la clé publique pouvait forger. Le premier
 * bloc ci-dessous mesure exactement cela, parce que c'est la propriété
 * qui manquait, pas la « force » du calcul.
 */

import { describe, it, expect } from 'vitest';
import {
  generateRsaKeyPair, rsaSign, rsaVerify, emsaPkcs1V15, isProbablePrime,
  materialToPrivateKey, materialToPublicKey, publicPartOf, modulusHex, bitLength,
  privateKeyToMaterial, publicKeyToMaterial, PUBLIC_EXPONENT,
} from '@/crypto/rsa';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

/** Une clé de 512 bits figée : les cas déterministes s'y appuient. */
const PRIV = 'rsa-priv:'
  + 'cdfa629f197e9b2152b7094a2bd32ece40026cb4d0875ae27e1914698377349707f8ec18dc95ab635f5'
  + '4223db8efe611baedff864bc39fdb675abf745862e727'
  + ':10001:'
  + '0a81be2c1d71ced9f94d2ae524ad26131142ce66bec858c37ae92e985f436264465c0c3b7307ee8337c'
  + '720cf5d2af406c918d605634351e1725f527299769f41';

describe('ce que la clé publique ne permet plus', () => {
  it('vérifier ne donne aucun moyen de signer', () => {
    const kp = generateRsaKeyPair(512);
    const message = utf8ToBytes('un document');
    const vraie = rsaSign(kp.privateKey, message);

    // L'ancien moteur reconstituait le privé depuis le public. Ici la
    // moitié publique ne porte que n et e : il n'y a rien à reconstituer.
    const pub = publicPartOf(privateKeyToMaterial(kp.privateKey));
    expect(pub).not.toContain(kp.privateKey.d.toString(16));
    expect(materialToPrivateKey(pub)).toBeNull();

    expect(rsaVerify(kp.publicKey, message, vraie)).toBe(true);
  });

  it('une signature faite par une autre clé est refusée', () => {
    const a = generateRsaKeyPair(512);
    const b = generateRsaKeyPair(512);
    const message = utf8ToBytes('un document');
    expect(rsaVerify(a.publicKey, message, rsaSign(b.privateKey, message))).toBe(false);
  });

  it('un message modifié d\'un octet est refusé', () => {
    const kp = generateRsaKeyPair(512);
    const sig = rsaSign(kp.privateKey, utf8ToBytes('virement de 10'));
    expect(rsaVerify(kp.publicKey, utf8ToBytes('virement de 90'), sig)).toBe(false);
  });

  it('une signature modifiée d\'un bit est refusée', () => {
    const kp = generateRsaKeyPair(512);
    const message = utf8ToBytes('un document');
    const sig = rsaSign(kp.privateKey, message);
    sig[10] ^= 0x01;
    expect(rsaVerify(kp.publicKey, message, sig)).toBe(false);
  });

  it('une signature de la mauvaise longueur est refusée sans calcul', () => {
    const kp = generateRsaKeyPair(512);
    const message = utf8ToBytes('un document');
    expect(rsaVerify(kp.publicKey, message, rsaSign(kp.privateKey, message).subarray(1))).toBe(false);
  });
});

describe('le déterminisme de PKCS#1 v1.5', () => {
  it('la même clé et le même message donnent la même signature', () => {
    const cle = materialToPrivateKey(PRIV)!;
    expect(bytesToHex(rsaSign(cle, utf8ToBytes('bonjour'))))
      .toBe('7f29ee5e07117748ef3c14996085cc12ee6808e079b695893d17db5f2538e52b'
        + '44a012aa492b259b23cb3bc6c1f0f3edd55623d86f56dc68ea39a6a84bcc8706');
  });

  it('et cette signature se vérifie contre la moitié publique de cette clé', () => {
    const pub = materialToPublicKey(PRIV)!;
    expect(rsaVerify(pub, utf8ToBytes('bonjour'),
      hexToBytes('7f29ee5e07117748ef3c14996085cc12ee6808e079b695893d17db5f2538e52b'
        + '44a012aa492b259b23cb3bc6c1f0f3edd55623d86f56dc68ea39a6a84bcc8706'))).toBe(true);
  });
});

describe('§9.2 — le bourrage EMSA-PKCS1-v1_5', () => {
  it('commence par 00 01, se remplit de FF, et se ferme par 00', () => {
    const em = emsaPkcs1V15(utf8ToBytes('x'), 64);
    expect(em[0]).toBe(0x00);
    expect(em[1]).toBe(0x01);
    expect(em[2]).toBe(0xff);
    // 51 octets de DigestInfo SHA-256 : le 00 séparateur est juste avant.
    expect(em[64 - 51 - 1]).toBe(0x00);
  });

  it('porte le DigestInfo DER de SHA-256', () => {
    const em = emsaPkcs1V15(utf8ToBytes('x'), 64);
    expect(bytesToHex(em.subarray(64 - 51, 64 - 51 + 19)))
      .toBe('3031300d060960864801650304020105000420');
  });

  it('refuse un module trop court pour le contenir', () => {
    // 51 + 11 = 62 octets minimum : c'est ce qui fixe le plancher de 512
    // bits, et un module plus petit ne peut pas porter cette signature.
    expect(() => emsaPkcs1V15(utf8ToBytes('x'), 61)).toThrow();
  });
});

describe('la génération de clés', () => {
  it('rend un module de la taille demandée, exactement', () => {
    for (const bits of [512, 768]) {
      expect(bitLength(generateRsaKeyPair(bits).publicKey.n)).toBe(bits);
    }
  });

  it('refuse une taille impraticable plutôt que d\'en fabriquer une inutilisable', () => {
    expect(() => generateRsaKeyPair(256)).toThrow();
    expect(() => generateRsaKeyPair(520)).toThrow();
  });

  it('utilise l\'exposant public usuel', () => {
    expect(generateRsaKeyPair(512).publicKey.e).toBe(PUBLIC_EXPONENT);
  });

  it('deux clés tirées de suite sont différentes', () => {
    expect(generateRsaKeyPair(512).publicKey.n).not.toBe(generateRsaKeyPair(512).publicKey.n);
  });

  it('le test de primalité reconnaît des premiers et rejette des composés', () => {
    expect(isProbablePrime(2n ** 61n - 1n)).toBe(true);  // premier de Mersenne
    expect(isProbablePrime(2n ** 64n + 1n)).toBe(false); // F6 = 274177 × 67280421310721
    // 561 = 3 × 11 × 17, le plus petit nombre de Carmichael : il trompe
    // le test de Fermat et pas celui de Miller-Rabin.
    expect(isProbablePrime(561n)).toBe(false);
  });
});

describe('la sérialisation que la PKI transporte', () => {
  it('la moitié publique ne contient pas l\'exposant privé', () => {
    const kp = generateRsaKeyPair(512);
    const priv = privateKeyToMaterial(kp.privateKey);
    expect(publicPartOf(priv)).toBe(publicKeyToMaterial(kp.publicKey));
    expect(publicPartOf(priv).split(':')).toHaveLength(3);
    expect(priv.split(':')).toHaveLength(4);
  });

  it('le module s\'affiche en hexadécimal majuscule, comme openssl', () => {
    const m = modulusHex(PRIV)!;
    expect(m).toMatch(/^[0-9A-F]+$/);
    expect(m).toHaveLength(128); // 512 bits
  });

  it('et il est le même vu depuis la clé privée ou depuis sa moitié publique', () => {
    // C'est le contrôle canonique qu'un administrateur fait pour apparier
    // une clé et son certificat.
    expect(modulusHex(PRIV)).toBe(modulusHex(publicPartOf(PRIV)));
  });
});

describe('PkiKeyPair passe par ce moteur', () => {
  it('signe et vérifie pour de vrai', () => {
    const kp = PkiKeyPair.generate('rsa', 512);
    const sig = PkiKeyPair.sign(kp.privateKey, 'contenu');
    expect(sig.startsWith('rsa:')).toBe(true);
    expect(PkiKeyPair.verify(kp.publicKey, 'contenu', sig)).toBe(true);
    expect(PkiKeyPair.verify(kp.publicKey, 'autre contenu', sig)).toBe(false);
  });

  it('et la clé publique d\'une paire ne vérifie pas la signature d\'une autre', () => {
    const a = PkiKeyPair.generate('rsa', 512);
    const b = PkiKeyPair.generate('rsa', 512);
    expect(PkiKeyPair.verify(a.publicKey, 'contenu', PkiKeyPair.sign(b.privateKey, 'contenu')))
      .toBe(false);
  });

  it('honore la taille demandée', () => {
    const kp = PkiKeyPair.generate('rsa', 1024);
    expect(bitLength(materialToPublicKey(kp.publicKey.material)!.n)).toBe(1024);
  });

  /**
   * Limite assumée, vérifiée plutôt que supposée : ECDSA n'a pas
   * d'implémentation ici — ni P-256 ni Ed25519 — et sa clé reste donc
   * simulée. Le test l'énonce pour que la disparition de cette ligne
   * signale le jour où quelqu'un l'aura implémenté.
   */
  it('ECDSA reste simulé, et c\'est le seul', () => {
    const kp = PkiKeyPair.generate('ecdsa');
    expect(kp.publicKey.material.startsWith('pub:')).toBe(true);
    expect(PkiKeyPair.verify(kp.publicKey, 'x', PkiKeyPair.sign(kp.privateKey, 'x'))).toBe(true);
  });
});
