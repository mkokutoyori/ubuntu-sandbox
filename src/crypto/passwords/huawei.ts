/**
 * Huawei VRP password schemes.
 *
 * The genuine VRP formats (the `@$@$…` cipher framing and the device-keyed
 * reversible cipher) are proprietary and undocumented, so these reproduce the
 * *algorithm family* with real, verifiable crypto rather than fabricating a
 * byte-exact match:
 *
 *   - irreversible-cipher → PBKDF2-HMAC-SHA256 (one-way), used for AAA secrets.
 *   - cipher              → AES-256-CBC (reversible), keyed by a fixed
 *                           simulator key (NOT a real device key).
 *
 * The aim is simply that `display current-configuration` stops echoing the
 * cleartext password.
 */

import { sha256, bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } from '@/crypto';
import { pbkdf2 } from '../kdf';
import { SHA256 } from '../hash';
import { aesCbcEncrypt, aesCbcDecrypt } from '../cipher';

const IRREVERSIBLE_ITERATIONS = 1000;
const SALT_BYTES = 8;
const KEY_BYTES = 32;

/** Fixed simulator key/IV for the reversible `cipher` (deterministic display). */
const CIPHER_KEY = sha256(utf8ToBytes('ubuntu-sandbox/huawei-vrp-cipher-key'));
const CIPHER_IV = sha256(utf8ToBytes('ubuntu-sandbox/huawei-vrp-cipher-iv')).subarray(0, 16);

/**
 * One-way PBKDF2-HMAC-SHA256 hash for `password irreversible-cipher …`.
 * Salt is derived deterministically from the password and embedded, so the
 * blob is stable per password without leaking the cleartext.
 */
export function huaweiIrreversibleCipher(password: string): string {
  const salt = sha256(utf8ToBytes(`huawei-irreversible:${password}`)).subarray(0, SALT_BYTES);
  const dk = pbkdf2(SHA256, utf8ToBytes(password), salt, IRREVERSIBLE_ITERATIONS, KEY_BYTES);
  const blob = new Uint8Array(salt.length + dk.length);
  blob.set(salt);
  blob.set(dk, salt.length);
  return bytesToBase64(blob).replace(/=+$/, '');
}

/** Reversible AES-256-CBC encoding for `password cipher …`. */
export function huaweiCipher(password: string): string {
  return bytesToBase64(aesCbcEncrypt(CIPHER_KEY, CIPHER_IV, utf8ToBytes(password))).replace(/=+$/, '');
}

/** Recover the plaintext from a {@link huaweiCipher} blob. */
export function huaweiDecipher(blob: string): string {
  return bytesToUtf8(aesCbcDecrypt(CIPHER_KEY, CIPHER_IV, base64ToBytes(blob)));
}
