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
 * Il ne reste PLUS de groupe simulé, et c'est le sens de ce dernier
 * passage. Tant qu'il en restait un, une poignée de main configurée des
 * deux côtés sur `secp384r1` réussissait et les deux bouts tombaient
 * d'accord sur un secret — mesuré, pas supposé — que n'importe quel
 * témoin des valeurs publiques recalculait : exactement le défaut que
 * l'étage 3 avait retiré à `x25519`, resté intact pour tout groupe sans
 * implémentation, et invisible parce que les seuls tests nommant
 * `secp384r1` s'en servaient pour provoquer une ABSENCE de groupe
 * commun.
 *
 * Le correctif n'est pas d'implémenter P-384 mais de cesser de
 * prétendre : un groupe qu'on ne sait pas calculer ne se négocie pas.
 * `isImplementedGroup` dit lesquels sont réels, les deux sessions
 * n'offrent et n'acceptent que ceux-là, et `sharedSecret` ABANDONNE au
 * lieu de fabriquer.
 */

import {
  x25519, x25519Base, isAllZero, X25519_KEY_LEN,
  p256Ecdh, p256PublicKey, generateP256PrivateScalar,
  materialToP256Public, p256PublicToMaterial, P256_FIELD_BYTES,
} from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

export const X25519_GROUP = 'x25519';
/** Le nom que la RFC 8446 §4.2.7 donne à la courbe P-256. */
export const P256_GROUP = 'secp256r1';

/**
 * Les groupes dont ce build sait réellement calculer un secret partagé.
 *
 * `secp384r1`, `ffdhe2048` et les autres restent des noms que la RFC
 * 8446 §4.2.7 définit et que ce simulateur n'implémente pas — la même
 * distinction que la troisième famille d'options du `PRD-Curl`.
 */
export const IMPLEMENTED_GROUPS: readonly string[] = [X25519_GROUP, P256_GROUP];

export function isImplementedGroup(group: string): boolean {
  return IMPLEMENTED_GROUPS.includes(group);
}

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
  // Un groupe sans implémentation garde une part BIEN FORMÉE mais vide :
  // les sessions le filtrent avant d'en arriver là, et si l'une d'elles
  // y arrivait quand même, c'est `sharedSecret` qui abandonne. Rendre un
  // condensé aléatoire ici donnerait une part que le pair croirait
  // valide.
  return { group, privateKey: new Uint8Array(0), share: `${group}:` };
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
 * `null` dans les trois cas où il n'y a pas de secret à rendre, et où
 * l'appelant doit donc émettre une alerte plutôt que continuer : un
 * résultat tout à zéro (RFC 8446 §7.4.2 — un point d'ordre faible
 * donnerait un secret que l'attaquant connaît d'avance), une part de
 * pair malformée ou d'un autre groupe, et un groupe dont ce build n'a
 * pas le code. Rendre quoi que ce soit dans l'un de ces cas serait la
 * seule façon de transformer un vrai échange de clés en faux.
 */
export function sharedSecret(own: KeyExchangeKeyPair, peerShare: string): string | null {
  if (own.group === X25519_GROUP) {
    const peer = peerPublicKey(peerShare);
    if (peer === null) return null;
    const partage = x25519(own.privateKey, peer);
    return isAllZero(partage) ? null : bytesToHex(partage);
  }

  if (own.group === P256_GROUP) {
    const parsee = parseShare(peerShare);
    if (!parsee || parsee.group !== P256_GROUP) return null;
    const q = materialToP256Public(`ec-pub:${parsee.body}`);
    if (q === null) return null;
    const d = BigInt(`0x${bytesToHex(own.privateKey)}`);
    const partage = p256Ecdh(d, q);
    return partage === null ? null : bytesToHex(partage);
  }

  return null;
}
