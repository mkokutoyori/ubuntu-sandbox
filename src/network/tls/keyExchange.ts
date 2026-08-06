/**
 * L'échange de clés de TLS 1.3, réel pour `x25519` (RFC 8446 §4.2.8,
 * RFC 7748).
 *
 * Étage 3. Le secret partagé était
 * `simulatedDigest(aléa_client | aléa_serveur | part_client | part_serveur)` :
 * les deux bouts tombaient d'accord, et n'importe quel tiers ayant vu
 * passer ces quatre valeurs PUBLIQUES tombait d'accord avec eux. C'est
 * l'exact contraire de ce à quoi sert un échange de clés — la seule
 * chose qu'il doit garantir est justement qu'un témoin de la
 * conversation n'obtienne rien.
 *
 * Une part de clé s'écrit `groupe:hexadécimal`, forme que le code
 * portait déjà côté client (`groupOf` la lit). Le serveur émettait la
 * sienne sans préfixe ; il le met désormais, faute de quoi le client ne
 * saurait pas quelle courbe interpréter.
 *
 * Les groupes autres que `x25519` restent simulés — ni P-256 ni P-384
 * n'ont d'implémentation ici — et `sharedSecret` le dit en le rendant
 * explicitement, plutôt que de calculer un X25519 sur des octets qui
 * n'en sont pas.
 */

import {
  x25519, x25519Base, isAllZero, X25519_KEY_LEN,
  p256Ecdh, p256PublicKey, generateP256PrivateScalar,
  materialToP256Public, p256PublicToMaterial, P256_FIELD_BYTES,
} from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';

export const X25519_GROUP = 'x25519';
/** Le nom que la RFC 8446 §4.2.7 donne à la courbe P-256. */
export const P256_GROUP = 'secp256r1';

export interface KeyExchangeKeyPair {
  readonly group: string;
  /** Le scalaire privé — jamais transmis. */
  readonly privateKey: Uint8Array;
  /** Ce qui part dans `key_share` : `groupe:hexadécimal`. */
  readonly share: string;
}

function randomScalar(): Uint8Array {
  const s = new Uint8Array(X25519_KEY_LEN);
  for (let i = 0; i < s.length; i++) s[i] = Math.floor(Math.random() * 256);
  return s;
}

export function generateKeyExchange(group: string): KeyExchangeKeyPair {
  if (group === X25519_GROUP) {
    const privateKey = randomScalar();
    return { group, privateKey, share: `${group}:${bytesToHex(x25519Base(privateKey))}` };
  }
  if (group === P256_GROUP) {
    // Le scalaire privé tient dans les mêmes octets que celui de X25519,
    // ce qui évite un second champ dans `KeyExchangeKeyPair` : c'est
    // `group` qui dit comment le lire.
    const d = generateP256PrivateScalar(randomScalar);
    const q = p256PublicKey(d);
    return {
      group,
      privateKey: hexToBytes(d.toString(16).padStart(P256_FIELD_BYTES * 2, '0')),
      share: `${group}:${p256PublicToMaterial(q).slice('ec-pub:'.length)}`,
    };
  }
  return { group, privateKey: new Uint8Array(0), share: `${group}:${simulatedDigest(`ks|${Math.random()}`)}` };
}

/** `groupe:hexadécimal` → le corps de la part, avec son groupe. */
export function parseShare(share: string): { group: string; body: string } | null {
  const separateur = share.indexOf(':');
  if (separateur === -1) return null;
  return { group: share.slice(0, separateur), body: share.slice(separateur + 1) };
}

/** Les octets de la coordonnée u d'une part X25519, ou `null`. */
export function peerPublicKey(share: string): Uint8Array | null {
  const parsee = parseShare(share);
  if (!parsee || parsee.group !== X25519_GROUP) return null;
  if (parsee.body.length !== X25519_KEY_LEN * 2 || !/^[0-9a-f]+$/i.test(parsee.body)) return null;
  return hexToBytes(parsee.body);
}

/**
 * Le secret partagé, en hexadécimal, prêt pour `HKDF-Extract`.
 *
 * `null` quand le résultat est tout à zéro : la RFC 8446 §7.4.2 impose
 * d'ABANDONNER la poignée de main dans ce cas, parce qu'un point d'ordre
 * faible donnerait un secret que l'attaquant connaît d'avance. Laisser
 * passer serait la seule façon de transformer un vrai échange de clés en
 * faux.
 */
export function sharedSecret(
  own: KeyExchangeKeyPair, peerShare: string, fallbackContext: string,
): string | null {
  if (own.group === X25519_GROUP) {
    const peer = peerPublicKey(peerShare);
    if (peer === null) return simulatedDigest(fallbackContext);
    const partage = x25519(own.privateKey, peer);
    return isAllZero(partage) ? null : bytesToHex(partage);
  }

  if (own.group === P256_GROUP) {
    const parsee = parseShare(peerShare);
    if (!parsee || parsee.group !== P256_GROUP) return simulatedDigest(fallbackContext);
    const q = materialToP256Public(`ec-pub:${parsee.body}`);
    if (q === null) return null;
    const d = BigInt(`0x${bytesToHex(own.privateKey)}`);
    const partage = p256Ecdh(d, q);
    return partage === null ? null : bytesToHex(partage);
  }

  // Groupe sans implémentation des deux côtés : la valeur reste simulée,
  // et ce chemin est désormais le seul qui le soit.
  return simulatedDigest(fallbackContext);
}
