/**
 * Cisco type-8 secrets ($8$) — the `enable algorithm-type sha256 secret …`
 * scheme. PBKDF2-HMAC-SHA256 over the password with a 14-char salt, 20 000
 * iterations, a 32-byte derived key, encoded with the crypt base64 alphabet
 * (no padding). Backed by the real PBKDF2/SHA-256 in `@/crypto`.
 */

import { pbkdf2 } from '../kdf';
import { SHA256 } from '../hash';
import { utf8ToBytes } from '../encoding';
import { cryptBase64 } from './cryptBase64';

const DEFAULT_ITERATIONS = 20_000;
const DERIVED_KEY_LEN = 32;

/**
 * Produce a full `$8$<salt>$<checksum>` type-8 string.
 *
 * @param salt        Salt characters (Cisco uses 14 from the crypt alphabet).
 * @param iterations  PBKDF2 rounds (Cisco fixes this at 20 000).
 */
export function ciscoType8(password: string, salt: string, iterations = DEFAULT_ITERATIONS): string {
  const dk = pbkdf2(SHA256, utf8ToBytes(password), utf8ToBytes(salt), iterations, DERIVED_KEY_LEN);
  return `$8$${salt}$${cryptBase64(dk)}`;
}
