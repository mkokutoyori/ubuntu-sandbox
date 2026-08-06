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

import { SHA256, sha256 } from '@/crypto/hash';
import { hmac } from '@/crypto/mac';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

/** p = 2^256 - 2^224 + 2^192 + 2^96 - 1 */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** L'ordre du point de base. */
export const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

export const P256_FIELD_BYTES = 32;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Inverse modulaire par Euclide étendu — plus rapide que Fermat ici. */
function invMod(a: bigint, m: bigint): bigint {
  let [g, x] = [m, 0n];
  let [u, y] = [mod(a, m), 1n];
  while (u !== 0n) {
    const q = g / u;
    [g, u] = [u, g - q * u];
    [x, y] = [y, x - q * y];
  }
  return mod(x, m);
}

/**
 * Les points sont en coordonnées jacobiennes (X, Y, Z) où x = X/Z², y =
 * Y/Z³. C'est ce qui évite une inversion modulaire par doublement : une
 * multiplication scalaire en demanderait 256 en affine, contre une seule
 * à la fin ici.
 */
type Jacobian = readonly [bigint, bigint, bigint];
const INFINITY: Jacobian = [0n, 0n, 0n];
const G: Jacobian = [GX, GY, 1n];

function double(p: Jacobian): Jacobian {
  const [x, y, z] = p;
  if (y === 0n) return INFINITY;
  const a = mod(y * y, P);
  const b = mod(4n * x * a, P);
  const c = mod(8n * a * a, P);
  const zz = mod(z * z, P);
  // a = -3 sur P-256, d'où la factorisation 3(x - z²)(x + z²).
  const d = mod(3n * mod(x - zz, P) * mod(x + zz, P), P);
  const x3 = mod(d * d - 2n * b, P);
  return [x3, mod(d * (b - x3) - c, P), mod(2n * y * z, P)];
}

function addPoints(p1: Jacobian, p2: Jacobian): Jacobian {
  const [x1, y1, z1] = p1;
  const [x2, y2, z2] = p2;
  if (z1 === 0n) return p2;
  if (z2 === 0n) return p1;
  const z1z1 = mod(z1 * z1, P);
  const z2z2 = mod(z2 * z2, P);
  const u1 = mod(x1 * z2z2, P);
  const u2 = mod(x2 * z1z1, P);
  const s1 = mod(y1 * z2 * z2z2, P);
  const s2 = mod(y2 * z1 * z1z1, P);
  if (u1 === u2) return s1 === s2 ? double(p1) : INFINITY;
  const h = mod(u2 - u1, P);
  const i = mod(mod(2n * h, P) * mod(2n * h, P), P);
  const j = mod(h * i, P);
  const r = mod(2n * (s2 - s1), P);
  const v = mod(u1 * i, P);
  const x3 = mod(r * r - j - 2n * v, P);
  return [
    x3,
    mod(r * (v - x3) - 2n * s1 * j, P),
    mod(mod(mod((z1 + z2) * (z1 + z2), P) - z1z1 - z2z2, P) * h, P),
  ];
}

function multiply(k: bigint, point: Jacobian): Jacobian {
  let result = INFINITY;
  let addend = point;
  let e = k;
  while (e > 0n) {
    if (e & 1n) result = addPoints(result, addend);
    addend = double(addend);
    e >>= 1n;
  }
  return result;
}

export interface P256Point { readonly x: bigint; readonly y: bigint }

function toAffine(p: Jacobian): P256Point | null {
  const [x, y, z] = p;
  if (z === 0n) return null;
  const zi = invMod(z, P);
  const zi2 = mod(zi * zi, P);
  return { x: mod(x * zi2, P), y: mod(y * zi2 * zi, P) };
}

function bytesToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (const octet of b) n = (n << 8n) | BigInt(octet);
  return n;
}

function bigToBytes(n: bigint, length = P256_FIELD_BYTES): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** La clé publique d'un scalaire privé : d·G. */
export function p256PublicKey(privateScalar: bigint): P256Point {
  const q = toAffine(multiply(mod(privateScalar, P256_ORDER), G));
  if (q === null) throw new RangeError('P-256: private scalar yields the point at infinity');
  return q;
}

/**
 * `k` déterministe (RFC 6979 §3.2) : un HMAC_DRBG semé par la clé privée
 * ET le condensé du message. Deux messages différents ne peuvent donc pas
 * partager un `k`, ce qui est exactement la faute qui livre la clé.
 */
export function rfc6979Nonce(privateScalar: bigint, messageHash: Uint8Array): bigint {
  const hm = (key: Uint8Array, ...parts: Uint8Array[]): Uint8Array => {
    let total = 0;
    for (const p of parts) total += p.length;
    const message = new Uint8Array(total);
    let i = 0;
    for (const p of parts) { message.set(p, i); i += p.length; }
    return hmac(SHA256, key, message);
  };

  const x = bigToBytes(privateScalar);
  const h1 = bigToBytes(mod(bytesToBig(messageHash), P256_ORDER));
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32).fill(0);

  k = hm(k, v, Uint8Array.from([0]), x, h1); v = hm(k, v);
  k = hm(k, v, Uint8Array.from([1]), x, h1); v = hm(k, v);

  for (;;) {
    v = hm(k, v);
    const candidate = bytesToBig(v);
    if (candidate >= 1n && candidate < P256_ORDER) return candidate;
    k = hm(k, v, Uint8Array.from([0]));
    v = hm(k, v);
  }
}

export interface P256Signature { readonly r: bigint; readonly s: bigint }

export function p256Sign(privateScalar: bigint, message: Uint8Array): P256Signature {
  const d = mod(privateScalar, P256_ORDER);
  const h = sha256(message);
  const z = mod(bytesToBig(h), P256_ORDER);
  for (;;) {
    const k = rfc6979Nonce(d, h);
    const point = toAffine(multiply(k, G));
    if (point === null) continue;
    const r = mod(point.x, P256_ORDER);
    if (r === 0n) continue;
    const s = mod(invMod(k, P256_ORDER) * (z + r * d), P256_ORDER);
    if (s === 0n) continue;
    return { r, s };
  }
}

export function p256Verify(q: P256Point, message: Uint8Array, sig: P256Signature): boolean {
  const { r, s } = sig;
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) return false;
  // Le point public doit être SUR la courbe : sans ce contrôle, une clé
  // fabriquée sur une courbe voisine ferait fuir le scalaire privé du
  // pair (attaque par courbe invalide).
  if (!isOnCurve(q)) return false;
  const z = mod(bytesToBig(sha256(message)), P256_ORDER);
  const w = invMod(s, P256_ORDER);
  const point = toAffine(addPoints(
    multiply(mod(z * w, P256_ORDER), G),
    multiply(mod(r * w, P256_ORDER), [q.x, q.y, 1n]),
  ));
  return point !== null && mod(point.x, P256_ORDER) === r;
}

const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

export function isOnCurve(q: P256Point): boolean {
  if (q.x < 0n || q.x >= P || q.y < 0n || q.y >= P) return false;
  return mod(q.y * q.y, P) === mod(q.x * q.x * q.x - 3n * q.x + B, P);
}

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

/**
 * ECDH sur P-256 : le secret partagé est l'abscisse de d·Q, comme le
 * demande la RFC 8446 §7.4.2 (« la coordonnée x du point calculé, sans
 * les octets de tête »).
 *
 * `null` si le point reçu n'est pas sur la courbe, ou si le produit tombe
 * à l'infini : accepter l'un ou l'autre donnerait un secret que
 * l'attaquant choisit.
 */
export function p256Ecdh(privateScalar: bigint, peer: P256Point): Uint8Array | null {
  if (!isOnCurve(peer)) return null;
  const point = toAffine(multiply(mod(privateScalar, P256_ORDER), [peer.x, peer.y, 1n]));
  return point === null ? null : bigToBytes(point.x);
}

/** Un scalaire privé tiré au hasard dans [1, n-1]. */
export function generateP256PrivateScalar(random: (n: number) => Uint8Array): bigint {
  for (;;) {
    const candidate = bytesToBig(random(P256_FIELD_BYTES));
    if (candidate >= 1n && candidate < P256_ORDER) return candidate;
  }
}
