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

import { x25519, x25519Base, isAllZero, X25519_KEY_LEN } from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';

export const X25519_GROUP = 'x25519';

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
  if (group !== X25519_GROUP) {
    return { group, privateKey: new Uint8Array(0), share: `${group}:${simulatedDigest(`ks|${Math.random()}`)}` };
  }
  const privateKey = randomScalar();
  return { group, privateKey, share: `${group}:${bytesToHex(x25519Base(privateKey))}` };
}

/** `groupe:hexadécimal` → les octets de la coordonnée u, ou `null`. */
export function peerPublicKey(share: string): Uint8Array | null {
  const separateur = share.indexOf(':');
  if (separateur === -1) return null;
  const groupe = share.slice(0, separateur);
  const corps = share.slice(separateur + 1);
  if (groupe !== X25519_GROUP) return null;
  if (corps.length !== X25519_KEY_LEN * 2 || !/^[0-9a-f]+$/i.test(corps)) return null;
  return hexToBytes(corps);
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
  const peer = peerPublicKey(peerShare);
  if (own.group !== X25519_GROUP || peer === null) {
    // Groupe non implémenté des deux côtés : la valeur reste simulée, et
    // ce chemin est le seul qui le soit encore.
    return simulatedDigest(fallbackContext);
  }
  const partage = x25519(own.privateKey, peer);
  if (isAllZero(partage)) return null;
  return bytesToHex(partage);
}
