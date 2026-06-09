/**
 * Oracle password verifiers — the hashes Oracle stores in SYS.USER$
 * (PASSWORD = 10g, SPARE4 = 11g `S:` and 12c `T:`). Built on the real DES,
 * SHA-1, SHA-512 and PBKDF2 in `@/crypto`. Verified against canonical vectors
 * (openssl for 10g, hashcat -m 112 / -m 12300 for 11g / 12c).
 */

import { desCbcEncrypt } from '../cipher';
import { sha1, sha512, SHA512 } from '../hash';
import { pbkdf2 } from '../kdf';
import { utf8ToBytes, bytesToHex } from '../encoding';

const DES_KEY_10G = hexBytes('0123456789ABCDEF');
const ZERO_IV_8 = new Uint8Array(8);
/** Fixed constant Oracle 12c appends to the salt for its PBKDF2 step. */
const PBKDF2_SPEEDY_KEY = utf8ToBytes('AUTH_PBKDF2_SPEEDY_KEY');
const ITER_12C = 4096;

/**
 * Legacy 10g hash (the SYS.USER$.PASSWORD column). DES-CBC of the UTF-16BE
 * UPPER(username||password) under a fixed key; the resulting last block keys a
 * second DES-CBC pass whose last block is the 16-hex hash. Case-insensitive.
 */
export function oracle10gHash(username: string, password: string): string {
  const data = utf16beUpper(username + password);
  const interKey = lastBlock(desCbcEncrypt(DES_KEY_10G, ZERO_IV_8, data));
  const hash = lastBlock(desCbcEncrypt(interKey, ZERO_IV_8, data));
  return bytesToHex(hash).toUpperCase();
}

/**
 * 11g verifier (`S:`): `S:` + SHA1(password || salt) + salt, uppercase hex.
 * The password is case-sensitive (UTF-8 bytes); salt is 10 bytes.
 */
export function oracle11gVerifier(password: string, salt: Uint8Array): string {
  const digest = sha1(concat(utf8ToBytes(password), salt));
  return `S:${bytesToHex(digest).toUpperCase()}${bytesToHex(salt).toUpperCase()}`;
}

/**
 * 12c verifier (`T:`): `T:` + SHA512(PBKDF2-HMAC-SHA512(password,
 * salt||AUTH_PBKDF2_SPEEDY_KEY, 4096, 64) || salt) + salt, uppercase hex.
 * Salt is 16 bytes.
 */
export function oracle12cVerifier(password: string, salt: Uint8Array): string {
  const key = pbkdf2(SHA512, utf8ToBytes(password), concat(salt, PBKDF2_SPEEDY_KEY), ITER_12C, 64);
  const digest = sha512(concat(key, salt));
  return `T:${bytesToHex(digest).toUpperCase()}${bytesToHex(salt).toUpperCase()}`;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** UTF-16BE bytes of UPPER(text), zero-padded to a multiple of 8. */
function utf16beUpper(text: string): Uint8Array {
  const s = text.toUpperCase();
  const padded = Math.ceil((s.length * 2) / 8) * 8;
  const out = new Uint8Array(padded);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = (s.charCodeAt(i) >> 8) & 0xff;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

const lastBlock = (bytes: Uint8Array): Uint8Array => bytes.subarray(bytes.length - 8);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
