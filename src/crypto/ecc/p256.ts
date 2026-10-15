/**
 * ECDSA sur P-256 (NIST FIPS 186-4), avec le `k` déterministe de la
 * RFC 6979.
 *
 * C'était le dernier chemin simulé de `PkiKeyPair` : `generate('ecdsa')`
 * rendait `pub:<graine>` / `priv:<graine>` et la « signature » était le
 * condensé FNV-1a que la clé publique suffisait à recalculer.
 *
 * Le `k` est DÉTERMINISTE, et ce n'est pas une commodité de test. Un
 * ECDSA à `k` tiré au hasard livre la clé privée entière dès que deux
 * signatures réutilisent le même `k` — c'est ainsi que la console PS3 a
 * été cassée. La RFC 6979 dérive `k` du message et de la clé par
 * HMAC_DRBG, ce qui supprime la question ; c'est aussi ce qui rend les
 * vecteurs de son annexe A.2.5 vérifiables, donc ce qui distingue cette
 * implémentation d'une invention plausible.
 *
 * Ce que ce fichier n'est pas : à temps constant. Arithmétique juste, pas
 * bibliothèque de sécurité.
 */

import { sha1 } from '@/crypto/hash';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { P256 } from './nistCurves';
import { bigToBytes as encodeBig, bytesToBig, type CurvePoint, type CurveSignature } from './nistCurve';

export const P256_ORDER = P256.order;

export const P256_FIELD_BYTES = P256.fieldBytes;

export type P256Point = CurvePoint;

export type P256Signature = CurveSignature;

export type P256Digest = 'sha256' | 'sha1';

const bigToBytes = (n: bigint, length = P256_FIELD_BYTES): Uint8Array => encodeBig(n, length);

export const p256PublicKey = (privateScalar: bigint): P256Point => P256.publicKey(privateScalar);

export const rfc6979Nonce = (privateScalar: bigint, messageHash: Uint8Array): bigint =>
  P256.nonce(privateScalar, messageHash);

export function p256Sign(privateScalar: bigint, message: Uint8Array, digest: P256Digest = 'sha256'): P256Signature {
  return digest === 'sha1' ? P256.signDigest(privateScalar, sha1(message)) : P256.sign(privateScalar, message);
}

export function p256Verify(q: P256Point, message: Uint8Array, sig: P256Signature, digest: P256Digest = 'sha256'): boolean {
  return digest === 'sha1' ? P256.verifyDigest(q, sha1(message), sig) : P256.verify(q, message, sig);
}

export const isOnCurve = (q: P256Point): boolean => P256.isOnCurve(q);

/**
 * La sérialisation que `PkiPublicKey.material` transporte : le point non
 * compressé de la SEC 1 (`04 || X || Y`), en hexadécimal. Ce n'est pas du
 * DER — même convention que le reste de `src/network/pki/` — mais c'est
 * l'encodage réel du point.
 */
export function p256PublicToMaterial(q: P256Point): string {
  return `ec-pub:04${bytesToHex(bigToBytes(q.x))}${bytesToHex(bigToBytes(q.y))}`;
}

export function p256PrivateToMaterial(d: bigint, q: P256Point): string {
  return `ec-priv:${bytesToHex(bigToBytes(d))}:04${bytesToHex(bigToBytes(q.x))}${bytesToHex(bigToBytes(q.y))}`;
}

export function materialToP256Public(material: string): P256Point | null {
  const parts = material.split(':');
  const point = parts[0] === 'ec-pub' ? parts[1] : parts[0] === 'ec-priv' ? parts[2] : null;
  if (!point || point.length !== 130 || !point.startsWith('04')) return null;
  try {
    return {
      x: bytesToBig(hexToBytes(point.slice(2, 66))),
      y: bytesToBig(hexToBytes(point.slice(66))),
    };
  } catch { return null; }
}

export function materialToP256Private(material: string): bigint | null {
  const parts = material.split(':');
  if (parts[0] !== 'ec-priv' || parts.length < 3) return null;
  try { return bytesToBig(hexToBytes(parts[1])); } catch { return null; }
}

export function p256PublicPartOf(material: string): string {
  const q = materialToP256Public(material);
  return q === null ? material : p256PublicToMaterial(q);
}

export function signatureToHex(sig: P256Signature): string {
  return `${bytesToHex(bigToBytes(sig.r))}${bytesToHex(bigToBytes(sig.s))}`;
}

export function hexToSignature(hex: string): P256Signature | null {
  if (hex.length !== 128) return null;
  try {
    return {
      r: bytesToBig(hexToBytes(hex.slice(0, 64))),
      s: bytesToBig(hexToBytes(hex.slice(64))),
    };
  } catch { return null; }
}

export const p256Ecdh = (privateScalar: bigint, peer: P256Point): Uint8Array | null =>
  P256.ecdh(privateScalar, peer);

export const generateP256PrivateScalar = (random: (n: number) => Uint8Array): bigint =>
  P256.generatePrivateScalar(random);
