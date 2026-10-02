import type { HashAlgorithm } from '@/crypto/hash';
import {
  beToBig, bigToBe, bitLength, byteLength, defaultRandom, modPow,
  type RandomBytes, type RsaPrivateKey, type RsaPublicKey,
} from './rsa';

function mgf1(hash: HashAlgorithm, seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let counter = 0, offset = 0; offset < length; counter++) {
    const input = new Uint8Array(seed.length + 4);
    input.set(seed, 0);
    new DataView(input.buffer).setUint32(seed.length, counter);
    const block = hash.digest(input);
    const take = Math.min(block.length, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

const EIGHT_ZEROS = new Uint8Array(8);

function mHash(hash: HashAlgorithm, message: Uint8Array, salt: Uint8Array): Uint8Array {
  const input = new Uint8Array(8 + hash.digestSize + salt.length);
  input.set(hash.digest(message), 8);
  input.set(salt, 8 + hash.digestSize);
  input.set(EIGHT_ZEROS, 0);
  return hash.digest(input);
}

export function emsaPssEncode(
  message: Uint8Array, emBits: number, hash: HashAlgorithm, saltLength: number, random: RandomBytes,
): Uint8Array {
  const emLen = Math.ceil(emBits / 8);
  if (emLen < hash.digestSize + saltLength + 2) throw new RangeError('RSA-PSS: encoding error, modulus too small');
  const salt = random(saltLength);
  const h = mHash(hash, message, salt);
  const db = new Uint8Array(emLen - hash.digestSize - 1);
  db[db.length - saltLength - 1] = 0x01;
  db.set(salt, db.length - saltLength);
  const mask = mgf1(hash, h, db.length);
  const maskedDb = db.map((byte, index) => byte ^ mask[index]);
  maskedDb[0] &= 0xff >> (8 * emLen - emBits);
  const em = new Uint8Array(emLen);
  em.set(maskedDb, 0);
  em.set(h, maskedDb.length);
  em[emLen - 1] = 0xbc;
  return em;
}

export function emsaPssVerify(
  message: Uint8Array, em: Uint8Array, emBits: number, hash: HashAlgorithm, saltLength: number,
): boolean {
  const emLen = Math.ceil(emBits / 8);
  if (em.length !== emLen || emLen < hash.digestSize + saltLength + 2) return false;
  if (em[emLen - 1] !== 0xbc) return false;
  const maskedDb = em.subarray(0, emLen - hash.digestSize - 1);
  const h = em.subarray(emLen - hash.digestSize - 1, emLen - 1);
  const topMask = (0xff << (8 - (8 * emLen - emBits))) & 0xff;
  if ((maskedDb[0] & topMask) !== 0) return false;
  const mask = mgf1(hash, h, maskedDb.length);
  const db = maskedDb.map((byte, index) => byte ^ mask[index]);
  db[0] &= 0xff >> (8 * emLen - emBits);
  const padding = db.length - saltLength - 1;
  for (let i = 0; i < padding; i++) if (db[i] !== 0) return false;
  if (db[padding] !== 0x01) return false;
  const expected = mHash(hash, message, db.subarray(db.length - saltLength));
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h[i] ^ expected[i];
  return diff === 0;
}

export function rsaPssSign(
  key: RsaPrivateKey, message: Uint8Array, hash: HashAlgorithm, saltLength: number = hash.digestSize,
  random: RandomBytes = defaultRandom,
): Uint8Array {
  const modBits = bitLength(key.n);
  const em = emsaPssEncode(message, modBits - 1, hash, saltLength, random);
  return bigToBe(modPow(beToBig(em), key.d, key.n), byteLength(key.n));
}

export function rsaPssVerify(
  key: RsaPublicKey, message: Uint8Array, signature: Uint8Array, hash: HashAlgorithm,
  saltLength: number = hash.digestSize,
): boolean {
  const k = byteLength(key.n);
  if (signature.length !== k) return false;
  const s = beToBig(signature);
  if (s >= key.n) return false;
  const modBits = bitLength(key.n);
  const emLen = Math.ceil((modBits - 1) / 8);
  const m = bigToBe(modPow(s, key.e, key.n), k);
  return emsaPssVerify(message, m.subarray(k - emLen), modBits - 1, hash, saltLength);
}
