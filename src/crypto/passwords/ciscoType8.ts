/**
 * Cisco type-8 secrets ($8$) — the `enable algorithm-type sha256 secret …`
 * scheme. PBKDF2-HMAC-SHA256 over the password with a 14-char salt, 20 000
 * iterations, a 32-byte derived key, encoded with the crypt base64 alphabet
 * (no padding). Backed by the real PBKDF2/SHA-256 in `@/crypto`.
 */

import { pbkdf2 } from '../kdf';
import { SHA256 } from '../hash';
import { utf8ToBytes } from '../encoding';

const DEFAULT_ITERATIONS = 20_000;
const DERIVED_KEY_LEN = 32;
/** crypt(3) base64 alphabet (same as md5crypt), used in standard bit order. */
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

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

/** Base64 with the crypt alphabet and standard (RFC 4648) bit order, no padding. */
function cryptBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += ITOA64[b1 >> 2];
    out += ITOA64[((b1 & 0x03) << 4) | (b2 >> 4)];
    if (i + 1 < data.length) out += ITOA64[((b2 & 0x0f) << 2) | (b3 >> 6)];
    if (i + 2 < data.length) out += ITOA64[b3 & 0x3f];
  }
  return out;
}
