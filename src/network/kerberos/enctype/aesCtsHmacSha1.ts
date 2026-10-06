import { aesCtsDecrypt, aesCtsEncrypt, aesEncryptBlock } from '@/crypto/cipher';
import { SHA1 } from '@/crypto/hash';
import { nFold, pbkdf2 } from '@/crypto/kdf';
import { hmac } from '@/crypto/mac';
import { systemRandom, type RandomSource } from '@/crypto/random';

export interface AesProfile {
  readonly etype: number;
  readonly name: string;
  readonly keyBytes: number;
  readonly checksumType: number;
}

export const AES128_CTS_HMAC_SHA1_96: AesProfile = {
  etype: 17, name: 'aes128-cts-hmac-sha1-96', keyBytes: 16, checksumType: 15,
};

export const AES256_CTS_HMAC_SHA1_96: AesProfile = {
  etype: 18, name: 'aes256-cts-hmac-sha1-96', keyBytes: 32, checksumType: 16,
};

export const DEFAULT_STRING_TO_KEY_ITERATIONS = 4096;

const BLOCK_BYTES = 16;
const CONFOUNDER_BYTES = BLOCK_BYTES;
const MAC_BYTES = 12;
const ZERO_IV = new Uint8Array(BLOCK_BYTES);
const KEY_CONSTANT = new TextEncoder().encode('kerberos');

const TAG_CHECKSUM = 0x99;
const TAG_ENCRYPTION = 0xaa;
const TAG_INTEGRITY = 0x55;

export class KerberosIntegrityError extends Error {
  constructor() {
    super('Decrypt integrity check failed');
    this.name = 'KerberosIntegrityError';
  }
}

export function profileOfEtype(etype: number): AesProfile | null {
  if (etype === AES128_CTS_HMAC_SHA1_96.etype) return AES128_CTS_HMAC_SHA1_96;
  if (etype === AES256_CTS_HMAC_SHA1_96.etype) return AES256_CTS_HMAC_SHA1_96;
  return null;
}

function usageConstant(usage: number, tag: number): Uint8Array {
  const constant = new Uint8Array(5);
  new DataView(constant.buffer).setUint32(0, usage, false);
  constant[4] = tag;
  return constant;
}

export function deriveKey(profile: AesProfile, key: Uint8Array, constant: Uint8Array): Uint8Array {
  const derived = new Uint8Array(profile.keyBytes);
  let block = nFold(constant, BLOCK_BYTES);
  for (let offset = 0; offset < profile.keyBytes; offset += BLOCK_BYTES) {
    block = aesEncryptBlock(key, block);
    derived.set(block.subarray(0, Math.min(BLOCK_BYTES, profile.keyBytes - offset)), offset);
  }
  return derived;
}

export function stringToKey(
  profile: AesProfile, password: string, salt: string, iterations: number = DEFAULT_STRING_TO_KEY_ITERATIONS,
): Uint8Array {
  const encoder = new TextEncoder();
  const seed = pbkdf2(SHA1, encoder.encode(password), encoder.encode(salt), iterations, profile.keyBytes);
  return deriveKey(profile, seed, KEY_CONSTANT);
}

export function encrypt(
  profile: AesProfile, key: Uint8Array, usage: number, plaintext: Uint8Array,
  random: RandomSource = systemRandom,
): Uint8Array {
  const confounded = new Uint8Array(CONFOUNDER_BYTES + plaintext.length);
  confounded.set(random(CONFOUNDER_BYTES), 0);
  confounded.set(plaintext, CONFOUNDER_BYTES);
  const cipher = aesCtsEncrypt(deriveKey(profile, key, usageConstant(usage, TAG_ENCRYPTION)), ZERO_IV, confounded);
  const mac = hmac(SHA1, deriveKey(profile, key, usageConstant(usage, TAG_INTEGRITY)), confounded).subarray(0, MAC_BYTES);
  const out = new Uint8Array(cipher.length + MAC_BYTES);
  out.set(cipher, 0);
  out.set(mac, cipher.length);
  return out;
}

export interface DecryptedMessage {
  readonly confounder: Uint8Array;
  readonly plaintext: Uint8Array;
}

export function decryptWithConfounder(
  profile: AesProfile, key: Uint8Array, usage: number, ciphertext: Uint8Array,
): DecryptedMessage {
  if (ciphertext.length < CONFOUNDER_BYTES + MAC_BYTES) throw new KerberosIntegrityError();
  const cipher = ciphertext.subarray(0, ciphertext.length - MAC_BYTES);
  const mac = ciphertext.subarray(ciphertext.length - MAC_BYTES);
  const confounded = aesCtsDecrypt(deriveKey(profile, key, usageConstant(usage, TAG_ENCRYPTION)), ZERO_IV, cipher);
  const expected = hmac(SHA1, deriveKey(profile, key, usageConstant(usage, TAG_INTEGRITY)), confounded).subarray(0, MAC_BYTES);
  let difference = 0;
  for (let index = 0; index < MAC_BYTES; index++) difference |= expected[index] ^ mac[index];
  if (difference !== 0) throw new KerberosIntegrityError();
  return { confounder: confounded.slice(0, CONFOUNDER_BYTES), plaintext: confounded.slice(CONFOUNDER_BYTES) };
}

export function decrypt(profile: AesProfile, key: Uint8Array, usage: number, ciphertext: Uint8Array): Uint8Array {
  return decryptWithConfounder(profile, key, usage, ciphertext).plaintext;
}

export function checksum(profile: AesProfile, key: Uint8Array, usage: number, data: Uint8Array): Uint8Array {
  return hmac(SHA1, deriveKey(profile, key, usageConstant(usage, TAG_CHECKSUM)), data).slice(0, MAC_BYTES);
}
