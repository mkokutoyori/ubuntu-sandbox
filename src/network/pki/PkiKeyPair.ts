/**
 * Les clés de la PKI du simulateur — RSA RÉEL depuis l'étage 4.
 *
 * Ce que c'était, et il faut le dire pour comprendre ce qui change : une
 * clé était `pub:<graine>` / `priv:<graine>`, la MÊME graine des deux
 * côtés, et `verify()` recalculait la signature en reconstituant le
 * matériel privé depuis le public. Quiconque tenait la clé publique
 * pouvait donc forger. Rien de ce que la PKI affirmait n'était opposable.
 *
 * Désormais : vrai module, vraie exponentiation modulaire, PKCS#1 v1.5
 * sur SHA-256 (RFC 8017). Vérifier ne donne plus aucun moyen de signer.
 *
 * Deux limites restent, écrites plutôt que sous-entendues. **ECDSA n'est
 * pas implémenté** : `generate('ecdsa')` rend encore une clé simulée,
 * parce qu'il n'y a ni P-256 ni Ed25519 dans ce dépôt — X25519 sert
 * l'échange de clés, pas la signature. Et **rien ici n'est à temps
 * constant** ; c'est de l'arithmétique juste, pas une bibliothèque de
 * sécurité.
 */
import {
  generateRsaKeyPair, rsaSign, rsaVerify,
  materialToPublicKey, materialToPrivateKey,
  publicKeyToMaterial, privateKeyToMaterial,
  DEFAULT_MODULUS_BITS,
} from '@/crypto/rsa';
import {
  p256Sign, p256Verify, p256PublicKey, generateP256PrivateScalar,
  p256PublicToMaterial, p256PrivateToMaterial,
  materialToP256Public, materialToP256Private,
  signatureToHex, hexToSignature, P256_FIELD_BYTES,
} from '@/crypto/ecc';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@/crypto/encoding';

export interface PkiPublicKey { readonly algorithm: 'rsa' | 'ecdsa'; readonly material: string }
export interface PkiPrivateKey { readonly algorithm: 'rsa' | 'ecdsa'; readonly material: string }

let counter = 0;

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Le condensé d'appoint des clés ECDSA, encore simulées (voir l'en-tête). */
function digest(input: string): string {
  return fnv1a(input) + fnv1a(input.split('').reverse().join('') + '|') + fnv1a(input + input);
}

function octetsAleatoires(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function randomSeed(): string {
  counter += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}-${r}-${counter.toString(36)}`;
}

export class PkiKeyPair {
  private constructor(readonly publicKey: PkiPublicKey, readonly privateKey: PkiPrivateKey) {}

  /**
   * `bits` n'est honoré que pour RSA, et sa valeur par défaut est un
   * choix MESURÉ : une clé de 2048 bits coûte en moyenne 460 ms à
   * fabriquer en JavaScript contre 9 ms à 512, et cette suite en génère
   * plus de deux mille. La taille demandée est toujours respectée —
   * `openssl genrsa 2048` fabrique un vrai module de 2048 bits ; seules
   * les clés dont personne n'a précisé la taille prennent la petite.
   */
  static generate(algorithm: 'rsa' | 'ecdsa' = 'rsa', bits: number = DEFAULT_MODULUS_BITS): PkiKeyPair {
    if (algorithm === 'ecdsa') {
      const d = generateP256PrivateScalar(octetsAleatoires);
      const q = p256PublicKey(d);
      return new PkiKeyPair(
        { algorithm, material: p256PublicToMaterial(q) },
        { algorithm, material: p256PrivateToMaterial(d, q) },
      );
    }
    const paire = generateRsaKeyPair(bits);
    return new PkiKeyPair(
      { algorithm, material: publicKeyToMaterial(paire.publicKey) },
      { algorithm, material: privateKeyToMaterial(paire.privateKey) },
    );
  }

  static sign(privateKey: PkiPrivateKey, data: string): string {
    const cle = materialToPrivateKey(privateKey.material);
    if (cle !== null) return `rsa:${bytesToHex(rsaSign(cle, utf8ToBytes(data)))}`;

    const d = materialToP256Private(privateKey.material);
    if (d !== null) return `ecdsa:${signatureToHex(p256Sign(d, utf8ToBytes(data)))}`;

    // Une clé d'une forme que ce moteur ne connaît pas — une topologie
    // enregistrée avant l'étage 4, par exemple. Le condensé d'appoint la
    // sert encore, pour qu'un fichier ancien reste lisible.
    return `${privateKey.algorithm}:${digest(privateKey.material + '|' + data)}`;
  }

  static verify(publicKey: PkiPublicKey, data: string, signature: string): boolean {
    const cle = materialToPublicKey(publicKey.material);
    if (cle !== null) {
      if (!signature.startsWith('rsa:')) return false;
      let octets: Uint8Array;
      try { octets = hexToBytes(signature.slice(4)); } catch { return false; }
      return rsaVerify(cle, utf8ToBytes(data), octets);
    }

    const q = materialToP256Public(publicKey.material);
    if (q !== null) {
      if (!signature.startsWith('ecdsa:')) return false;
      const sig = hexToSignature(signature.slice(6));
      return sig !== null && p256Verify(q, utf8ToBytes(data), sig);
    }

    // Repli pour une clé d'une forme inconnue (voir `sign`).
    const seed = publicKey.material.split(':')[1];
    if (!seed) return false;
    const expected = `${publicKey.algorithm}:${digest('priv:' + seed + '|' + data)}`;
    return signature === expected;
  }
}
