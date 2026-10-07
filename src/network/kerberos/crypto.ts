import { systemRandom, type RandomSource } from '@/crypto/random';
import {
  AES256_PROFILE, decrypt, encrypt, stringToKey as deriveKeyFromSecret,
} from './enctype/aesCtsHmacSha1';

export const AES256_CTS_HMAC_SHA1_96 = AES256_PROFILE.etype;

export const KU_PA_ENC_TIMESTAMP = 1;
export const KU_TICKET = 2;
export const KU_AS_REP_ENC_PART = 3;
export const KU_TGS_REQ_AUTH_CKSUM = 6;
export const KU_TGS_REQ_AUTHENTICATOR = 7;
export const KU_TGS_REP_ENC_PART = 8;
export const KU_TGS_REP_ENC_PART_SUBKEY = 9;
export const KU_AP_REQ_AUTH_CKSUM = 10;
export const KU_AP_REQ_AUTHENTICATOR = 11;
export const KU_AP_REP_ENC_PART = 12;
export const KU_GSS_ACCEPTOR_SEAL = 22;
export const KU_GSS_ACCEPTOR_SIGN = 23;
export const KU_GSS_INITIATOR_SEAL = 24;
export const KU_GSS_INITIATOR_SIGN = 25;

const SESSION_KEY_BYTES = AES256_PROFILE.keyBytes;
const SECRET_BYTES = 16;
const KEY_CACHE_LIMIT = 256;

const derivedKeys = new Map<string, Uint8Array>();

export function accountSalt(realm: string, ...components: readonly string[]): string {
  return `${realm}${components.join('')}`;
}

export function machineSalt(realm: string, hostName: string): string {
  return `${realm.toUpperCase()}host${hostName.toLowerCase()}.${realm.toLowerCase()}`;
}

export function stringToKey(secret: string, salt: string): Uint8Array {
  const cacheKey = `${salt}\u0000${secret}`;
  const cached = derivedKeys.get(cacheKey);
  if (cached !== undefined) return cached;
  const derived = deriveKeyFromSecret(AES256_PROFILE, secret, salt);
  if (derivedKeys.size >= KEY_CACHE_LIMIT) derivedKeys.delete(derivedKeys.keys().next().value as string);
  derivedKeys.set(cacheKey, derived);
  return derived;
}

export function encryptWithUsage(
  key: Uint8Array, usage: number, plaintext: Uint8Array, random: RandomSource = systemRandom,
): Uint8Array {
  return encrypt(AES256_PROFILE, key, usage, plaintext, random);
}

export function decryptWithUsage(key: Uint8Array, usage: number, ciphertext: Uint8Array): Uint8Array {
  return decrypt(AES256_PROFILE, key, usage, ciphertext);
}

export function randomSessionKey(random: RandomSource = systemRandom): Uint8Array {
  return random(SESSION_KEY_BYTES);
}

export function randomSecret(random: RandomSource = systemRandom): string {
  return Array.from(random(SECRET_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
