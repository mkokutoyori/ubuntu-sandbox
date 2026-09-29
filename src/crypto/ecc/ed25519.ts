import { sha512 } from '../hash/sha512';
import {
  P25519, bigIntToLittleEndian, invert25519, littleEndianToBigInt, mod25519, pow25519,
} from './curve25519Field';
import { clampScalar } from './x25519';

export const ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
export const ED25519_KEY_LEN = 32;
export const ED25519_SIGNATURE_LEN = 64;

interface ExtendedPoint {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
  readonly t: bigint;
}

const D = mod25519(-121665n * invert25519(121666n));
const D2 = mod25519(2n * D);
const SQRT_MINUS_ONE = pow25519(2n, (P25519 - 1n) / 4n);
const IDENTITY: ExtendedPoint = { x: 0n, y: 1n, z: 1n, t: 0n };

function add(p: ExtendedPoint, q: ExtendedPoint): ExtendedPoint {
  const a = mod25519((p.y - p.x) * (q.y - q.x));
  const b = mod25519((p.y + p.x) * (q.y + q.x));
  const c = mod25519(p.t * D2 * q.t);
  const d = mod25519(2n * p.z * q.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { x: mod25519(e * f), y: mod25519(g * h), t: mod25519(e * h), z: mod25519(f * g) };
}

function double(p: ExtendedPoint): ExtendedPoint {
  const a = mod25519(p.x * p.x);
  const b = mod25519(p.y * p.y);
  const c = mod25519(2n * p.z * p.z);
  const h = a + b;
  const e = h - mod25519((p.x + p.y) * (p.x + p.y));
  const g = a - b;
  const f = c + g;
  return { x: mod25519(e * f), y: mod25519(g * h), t: mod25519(e * h), z: mod25519(f * g) };
}

function multiply(scalar: bigint, point: ExtendedPoint): ExtendedPoint {
  let result = IDENTITY;
  for (let bit = BigInt(scalar.toString(2).length - 1); bit >= 0n; bit--) {
    result = double(result);
    if ((scalar >> bit) & 1n) result = add(result, point);
  }
  return result;
}

function sameAffinePoint(p: ExtendedPoint, q: ExtendedPoint): boolean {
  return mod25519(p.x * q.z - q.x * p.z) === 0n && mod25519(p.y * q.z - q.y * p.z) === 0n;
}

function encode(point: ExtendedPoint): Uint8Array {
  const zInverse = invert25519(point.z);
  const x = mod25519(point.x * zInverse);
  const y = mod25519(point.y * zInverse);
  const bytes = bigIntToLittleEndian(y);
  bytes[31] |= Number(x & 1n) << 7;
  return bytes;
}

function recoverX(y: bigint, sign: bigint): bigint | null {
  const u = mod25519(y * y - 1n);
  const v = mod25519(D * y * y + 1n);
  const v3 = mod25519(v * v * v);
  let x = mod25519(u * v3 * pow25519(u * v3 * v3 * v, (P25519 - 5n) / 8n));
  const check = mod25519(v * x * x);
  if (check === mod25519(-u)) x = mod25519(x * SQRT_MINUS_ONE);
  else if (check !== u) return null;
  if (x === 0n && sign === 1n) return null;
  return (x & 1n) === sign ? x : P25519 - x;
}

function decode(bytes: Uint8Array): ExtendedPoint | null {
  if (bytes.length !== ED25519_KEY_LEN) return null;
  const sign = BigInt(bytes[31] >> 7);
  const yBytes = Uint8Array.from(bytes);
  yBytes[31] &= 0x7f;
  const y = littleEndianToBigInt(yBytes);
  if (y >= P25519) return null;
  const x = recoverX(y, sign);
  if (x === null) return null;
  return { x, y, z: 1n, t: mod25519(x * y) };
}

const BASE: ExtendedPoint = (() => {
  const y = mod25519(4n * invert25519(5n));
  const x = recoverX(y, 0n)!;
  return { x, y, z: 1n, t: mod25519(x * y) };
})();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function reducedHash(...parts: readonly Uint8Array[]): bigint {
  return littleEndianToBigInt(sha512(concat(...parts))) % ED25519_ORDER;
}

function expandSeed(seed: Uint8Array): { scalar: bigint; prefix: Uint8Array } {
  const digest = sha512(seed);
  return {
    scalar: littleEndianToBigInt(clampScalar(digest.subarray(0, 32))),
    prefix: digest.subarray(32, 64),
  };
}

export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  return encode(multiply(expandSeed(seed).scalar, BASE));
}

export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  const { scalar, prefix } = expandSeed(seed);
  const publicKey = encode(multiply(scalar, BASE));
  const r = reducedHash(prefix, message);
  const encodedR = encode(multiply(r, BASE));
  const k = reducedHash(encodedR, publicKey, message);
  const s = (r + k * scalar) % ED25519_ORDER;
  return concat(encodedR, bigIntToLittleEndian(s));
}

export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== ED25519_SIGNATURE_LEN) return false;
  const a = decode(publicKey);
  const encodedR = signature.subarray(0, 32);
  const r = decode(encodedR);
  if (a === null || r === null) return false;
  const s = littleEndianToBigInt(signature.subarray(32, 64));
  if (s >= ED25519_ORDER) return false;
  const k = reducedHash(encodedR, publicKey, message);
  return sameAffinePoint(multiply(s, BASE), add(r, multiply(k, a)));
}
