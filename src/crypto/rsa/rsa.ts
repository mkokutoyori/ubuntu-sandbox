/**
 * RSA réel : génération de clés, PKCS#1 v1.5 et signature sur SHA-256
 * (RFC 8017 §8.2, §9.2).
 *
 * Étage 4. Une clé était `pub:<graine>` / `priv:<graine>` — la même
 * graine des deux côtés — et la « signature » une empreinte FNV-1a dont
 * la vérification reconstituait le matériel privé à partir du public.
 * Autrement dit, quiconque tenait la clé publique pouvait forger. Ici il
 * y a un vrai module, une vraie exponentiation modulaire, et vérifier ne
 * donne aucun moyen de signer.
 *
 * Ce que ce fichier N'EST PAS, écrit ici pour que personne ne s'y trompe :
 * ce n'est pas à temps constant, la génération de premiers n'emploie pas
 * de crible sophistiqué, et le module par défaut est petit (voir
 * `DEFAULT_MODULUS_BITS`). C'est de l'arithmétique juste, pas une
 * bibliothèque de sécurité — rien de ce qui sort d'ici ne doit protéger
 * quoi que ce soit de réel.
 *
 * La taille par défaut est un choix MESURÉ, pas une facilité : une clé de
 * 2048 bits coûte en moyenne 460 ms à fabriquer en JavaScript, et la
 * suite de tests de ce dépôt en génère plus de deux mille — un quart
 * d'heure d'attente pour des clés dont aucun test ne regarde la taille.
 * À 512 bits la même clé coûte 9 ms. La taille demandée est donc toujours
 * honorée (`openssl genrsa 2048` fabrique un vrai module de 2048 bits) ;
 * seules les clés dont personne n'a précisé la taille prennent la petite.
 */

import { sha256 } from '@/crypto/hash';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';

/** Voir l'en-tête : mesuré, pas choisi par confort. */
export const DEFAULT_MODULUS_BITS = 512;

/** Le e usuel, 2^16 + 1 (RFC 8017 §3.1 le recommande). */
export const PUBLIC_EXPONENT = 65537n;

export interface RsaPublicKey { readonly n: bigint; readonly e: bigint }
export interface RsaPrivateKey { readonly n: bigint; readonly e: bigint; readonly d: bigint }

export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = base % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function egcd(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  if (b === 0n) return { g: a, x: 1n, y: 0n };
  const r = egcd(b, a % b);
  return { g: r.g, x: r.y, y: r.x - (a / b) * r.y };
}

function invMod(a: bigint, m: bigint): bigint {
  const { g, x } = egcd(a % m, m);
  if (g !== 1n) throw new Error('RSA: no modular inverse');
  return ((x % m) + m) % m;
}

const SMALL_PRIMES: readonly bigint[] = [
  3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n,
  53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n,
];

export type RandomBytes = (n: number) => Uint8Array;

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * Un candidat impair de `bits` bits dont les DEUX bits de tête sont à un :
 * cela garantit que le produit de deux premiers de n/2 bits fasse
 * exactement n bits, sans quoi `openssl genrsa 2048` rendrait de temps en
 * temps un module de 2047.
 */
function randomOddCandidate(bits: number, random: RandomBytes): bigint {
  const bytes = random(bits / 8);
  bytes[0] |= 0xc0;
  bytes[bytes.length - 1] |= 1;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** Miller-Rabin (RFC 8017 le laisse au générateur ; c'est le test usuel). */
export function isProbablePrime(n: bigint, rounds = 20, random: RandomBytes = defaultRandom): boolean {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) { d >>= 1n; s++; }

  for (let i = 0; i < rounds; i++) {
    // Une base tirée au hasard dans [2, n-2]. Des bases fixes rendraient
    // le test contournable par un menteur de Carmichael construit exprès.
    let a = 0n;
    for (const b of random(8)) a = (a << 8n) | BigInt(b);
    a = 2n + (a % (n - 4n < 1n ? 1n : n - 4n));
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let temoin = true;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) { temoin = false; break; }
    }
    if (temoin) return false;
  }
  return true;
}

function generatePrime(bits: number, random: RandomBytes): bigint {
  for (;;) {
    const candidate = randomOddCandidate(bits, random);
    if (candidate % PUBLIC_EXPONENT === 0n) continue;
    if ((candidate - 1n) % PUBLIC_EXPONENT === 0n) continue; // e doit être inversible mod (p-1)
    if (isProbablePrime(candidate, 20, random)) return candidate;
  }
}

export interface RsaKeyPair {
  readonly publicKey: RsaPublicKey;
  readonly privateKey: RsaPrivateKey;
}

export function generateRsaKeyPair(
  bits: number = DEFAULT_MODULUS_BITS, random: RandomBytes = defaultRandom,
): RsaKeyPair {
  if (bits < 512 || bits % 16 !== 0) {
    // 512 est le plancher praticable : une signature PKCS#1 v1.5 sur
    // SHA-256 occupe 62 octets, et un module de 512 bits en offre 64.
    throw new RangeError('RSA: modulus must be a multiple of 16 and at least 512 bits');
  }
  for (;;) {
    const p = generatePrime(bits / 2, random);
    const q = generatePrime(bits / 2, random);
    if (p === q) continue;
    const n = p * q;
    if (bitLength(n) !== bits) continue;
    const phi = (p - 1n) * (q - 1n);
    const d = invMod(PUBLIC_EXPONENT, phi);
    return {
      publicKey: { n, e: PUBLIC_EXPONENT },
      privateKey: { n, e: PUBLIC_EXPONENT, d },
    };
  }
}

export function bitLength(n: bigint): number {
  return n.toString(2).length;
}

function byteLength(n: bigint): number {
  return Math.ceil(bitLength(n) / 8);
}

function bigToBe(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function beToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Le `DigestInfo` DER de SHA-256, tel que la RFC 8017 §9.2 note 1 le
 * donne. C'est une constante de la norme, pas un encodeur : la seule
 * variante que ce module signe est SHA-256.
 */
const SHA256_DIGEST_INFO_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,
  0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

/**
 * `EMSA-PKCS1-v1_5` (§9.2) : `0x00 || 0x01 || PS || 0x00 || T`, où PS est
 * du 0xFF et fait au moins huit octets. Le bourrage n'est pas décoratif —
 * c'est lui qui empêche une signature d'être réutilisée pour un autre
 * condensé de même valeur numérique.
 */
export function emsaPkcs1V15(message: Uint8Array, emLen: number): Uint8Array {
  const t = new Uint8Array(SHA256_DIGEST_INFO_PREFIX.length + 32);
  t.set(SHA256_DIGEST_INFO_PREFIX, 0);
  t.set(sha256(message), SHA256_DIGEST_INFO_PREFIX.length);
  if (emLen < t.length + 11) throw new RangeError('RSA: intended encoded message length too short');

  const em = new Uint8Array(emLen);
  em[0] = 0x00;
  em[1] = 0x01;
  em.fill(0xff, 2, emLen - t.length - 1);
  em[emLen - t.length - 1] = 0x00;
  em.set(t, emLen - t.length);
  return em;
}

/** `RSASSA-PKCS1-V1_5-SIGN` (§8.2.1). */
export function rsaSign(key: RsaPrivateKey, message: Uint8Array): Uint8Array {
  const k = byteLength(key.n);
  const em = emsaPkcs1V15(message, k);
  return bigToBe(modPow(beToBig(em), key.d, key.n), k);
}

/**
 * `RSASSA-PKCS1-V1_5-VERIFY` (§8.2.2) : on ré-encode et on compare, plutôt
 * que de décortiquer le bourrage reçu. C'est la forme que la RFC
 * recommande, et celle qui ferme la porte aux signatures forgées à la
 * Bleichenbacher sur un bourrage trop permissif.
 */
export function rsaVerify(key: RsaPublicKey, message: Uint8Array, signature: Uint8Array): boolean {
  const k = byteLength(key.n);
  if (signature.length !== k) return false;
  const s = beToBig(signature);
  if (s >= key.n) return false;
  let attendu: Uint8Array;
  try {
    attendu = emsaPkcs1V15(message, k);
  } catch {
    return false;
  }
  const em = bigToBe(modPow(s, key.e, key.n), k);
  let diff = 0;
  for (let i = 0; i < k; i++) diff |= em[i] ^ attendu[i];
  return diff === 0;
}

/**
 * La sérialisation que `PkiPublicKey.material`/`PkiPrivateKey.material`
 * transportent. Elle n'est pas du DER — même convention que le reste de
 * `src/network/pki/` — mais elle porte les VRAIS entiers, si bien que
 * `openssl rsa -modulus` a maintenant un module à afficher.
 */
export function publicKeyToMaterial(k: RsaPublicKey): string {
  return `rsa-pub:${bytesToHex(bigToBe(k.n, byteLength(k.n)))}:${k.e.toString(16)}`;
}

export function privateKeyToMaterial(k: RsaPrivateKey): string {
  return `rsa-priv:${bytesToHex(bigToBe(k.n, byteLength(k.n)))}:${k.e.toString(16)}`
    + `:${bytesToHex(bigToBe(k.d, byteLength(k.n)))}`;
}

export function materialToPublicKey(material: string): RsaPublicKey | null {
  const parts = material.split(':');
  if (parts[0] !== 'rsa-pub' && parts[0] !== 'rsa-priv') return null;
  if (parts.length < 3) return null;
  try {
    return { n: beToBig(hexToBytes(parts[1])), e: BigInt(`0x${parts[2]}`) };
  } catch { return null; }
}

export function materialToPrivateKey(material: string): RsaPrivateKey | null {
  const parts = material.split(':');
  if (parts[0] !== 'rsa-priv' || parts.length < 4) return null;
  try {
    return {
      n: beToBig(hexToBytes(parts[1])),
      e: BigInt(`0x${parts[2]}`),
      d: beToBig(hexToBytes(parts[3])),
    };
  } catch { return null; }
}

/** La moitié publique d'une clé privée — ce que `rsa -pubout` extrait. */
export function publicPartOf(material: string): string {
  const pub = materialToPublicKey(material);
  return pub === null ? material : publicKeyToMaterial(pub);
}

/** Le module en hexadécimal majuscule, la forme qu'openssl affiche. */
export function modulusHex(material: string): string | null {
  const pub = materialToPublicKey(material);
  return pub === null ? null : bytesToHex(bigToBe(pub.n, byteLength(pub.n))).toUpperCase();
}
