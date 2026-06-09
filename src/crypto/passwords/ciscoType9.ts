/**
 * Cisco type-9 secrets ($9$) — the `enable algorithm-type scrypt secret …`
 * scheme. scrypt(password, salt, N=16384, r=1, p=1) → 32-byte key, encoded
 * with the crypt base64 alphabet (no padding). Backed by the real scrypt in
 * `@/crypto`.
 */

import { scrypt } from '../kdf';
import { utf8ToBytes } from '../encoding';
import { cryptBase64 } from './cryptBase64';

const N = 16_384; // 2^14, Cisco's fixed cost factor
const R = 1;
const P = 1;
const DERIVED_KEY_LEN = 32;

/**
 * Produce a full `$9$<salt>$<checksum>` type-9 string.
 *
 * @param salt  Salt characters (Cisco uses 14 from the crypt alphabet).
 */
export function ciscoType9(password: string, salt: string): string {
  const dk = scrypt(utf8ToBytes(password), utf8ToBytes(salt), N, R, P, DERIVED_KEY_LEN);
  return `$9$${salt}$${cryptBase64(dk)}`;
}
