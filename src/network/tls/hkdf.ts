/**
 * HKDF-SHA256 réel (RFC 5869) et `HKDF-Expand-Label` de TLS 1.3
 * (RFC 8446 §7.1).
 *
 * Ce module remplace le `simulatedDigest` sur lequel reposait tout le
 * calendrier de clés. Le HMAC, lui, était déjà réel (`src/crypto/mac`,
 * RFC 2104) : il ne manquait que les trente lignes qui en font un KDF.
 * Une dérivation simulée donnait déjà des secrets qui divergent quand ils
 * doivent diverger — l'arbre du §7.1 est une propriété de structure —
 * mais elle ne pouvait pas être confrontée à une autre implémentation.
 * Celle-ci le peut : les vecteurs d'essai de la RFC 5869 passent, et
 * c'est ce qui la distingue d'une invention plausible.
 *
 * Les secrets restent des CHAÎNES, en hexadécimal, parce que c'est le
 * type que tout le reste du TLS de ce dépôt échange. `toBytes` accepte
 * donc les deux formes : de l'hexadécimal quand c'en est, sinon les
 * octets UTF-8 — un appelant qui passe une étiquette de PSK ou un secret
 * partagé encore simulé n'a rien à changer.
 */

import { SHA256 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

/** La taille de sortie de SHA-256, celle que le §7.1 appelle `Hash.length`. */
export const HASH_LEN = 32;

const HEX = /^[0-9a-fA-F]+$/;

export function toBytes(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 2 === 0 && HEX.test(s)) return hexToBytes(s);
  return utf8ToBytes(s);
}

/** `HKDF-Extract(salt, IKM) = HMAC-Hash(salt, IKM)` (RFC 5869 §2.2). */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmac(SHA256, salt, ikm);
}

/**
 * `HKDF-Expand(PRK, info, L)` (RFC 5869 §2.3) : T(n) = HMAC(PRK,
 * T(n-1) ‖ info ‖ n), les octets de sortie étant la concaténation
 * tronquée à L. Le compteur est sur UN octet, d'où la limite de 255
 * blocs qu'impose la RFC.
 */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length > 255 * HASH_LEN) throw new RangeError('HKDF: requested length too large');
  const out = new Uint8Array(length);
  let previous = new Uint8Array(0);
  let written = 0;
  for (let counter = 1; written < length; counter++) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[input.length - 1] = counter;
    previous = hmac(SHA256, prk, input);
    const take = Math.min(previous.length, length - written);
    out.set(previous.subarray(0, take), written);
    written += take;
  }
  return out;
}

/**
 * La structure `HkdfLabel` du §7.1, sérialisée telle qu'elle :
 *
 *   struct {
 *     uint16 length;
 *     opaque label<7..255>   = "tls13 " + Label;
 *     opaque context<0..255> = Context;
 *   } HkdfLabel;
 *
 * Les deux `opaque` portent leur longueur sur un octet. Se tromper ici ne
 * se verrait pas entre deux implémentations identiques — c'est justement
 * pourquoi la forme est écrite, et non résumée en concaténation.
 */
export function hkdfLabel(length: number, label: string, context: Uint8Array): Uint8Array {
  const etiquette = utf8ToBytes(`tls13 ${label}`);
  const out = new Uint8Array(2 + 1 + etiquette.length + 1 + context.length);
  let i = 0;
  out[i++] = (length >> 8) & 0xff;
  out[i++] = length & 0xff;
  out[i++] = etiquette.length;
  out.set(etiquette, i); i += etiquette.length;
  out[i++] = context.length;
  out.set(context, i);
  return out;
}

/** `HKDF-Expand-Label(Secret, Label, Context, Length)` (RFC 8446 §7.1). */
export function hkdfExpandLabel(
  secret: Uint8Array, label: string, context: Uint8Array, length: number,
): Uint8Array {
  return hkdfExpand(secret, hkdfLabel(length, label, context), length);
}

/** Les mêmes, du côté des chaînes hexadécimales que ce TLS échange. */
export function extractHex(salt: string, ikm: string): string {
  return bytesToHex(hkdfExtract(toBytes(salt), toBytes(ikm)));
}

export function expandLabelHex(
  secret: string, label: string, context: string, length = HASH_LEN,
): string {
  return bytesToHex(hkdfExpandLabel(toBytes(secret), label, toBytes(context), length));
}
