/**
 * PBKDF2 (RFC 2898 / PKCS#5 v2) — password-based key derivation.
 *
 * Parameterised by a {@link HashAlgorithm} via HMAC, so the same routine
 * backs PBKDF2-HMAC-SHA1, -SHA256, etc. Deliberately iteration-heavy; that
 * slowness is the point, and Cisco type-8 relies on it (20 000 rounds).
 */

import type { HashAlgorithm } from '../hash';
import { hmac } from '../mac';
import { utf8ToBytes, bytesToHex } from '../encoding';

/**
 * Derive `dkLen` bytes from `password`/`salt` using `iterations` rounds.
 *
 * @throws if `dkLen` or `iterations` is not a positive integer.
 */
export function pbkdf2(
  hash: HashAlgorithm,
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Uint8Array {
  if (!Number.isInteger(dkLen) || dkLen <= 0) {
    throw new Error(`pbkdf2: dkLen must be a positive integer (got ${dkLen})`);
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`pbkdf2: iterations must be a positive integer (got ${iterations})`);
  }

  const hLen = hash.digestSize;
  const blocks = Math.ceil(dkLen / hLen);
  const dk = new Uint8Array(blocks * hLen);

  // INT_32_BE(i) appended to the salt for each block (RFC 2898 §5.2).
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);

  for (let i = 1; i <= blocks; i++) {
    block[salt.length] = (i >>> 24) & 0xff;
    block[salt.length + 1] = (i >>> 16) & 0xff;
    block[salt.length + 2] = (i >>> 8) & 0xff;
    block[salt.length + 3] = i & 0xff;

    // U_1 = PRF(password, salt || INT(i)); T = U_1, then XOR in U_2..U_c.
    let u = hmac(hash, password, block);
    const t = Uint8Array.from(u);
    for (let c = 1; c < iterations; c++) {
      u = hmac(hash, password, u);
      for (let k = 0; k < hLen; k++) t[k] ^= u[k];
    }
    dk.set(t, (i - 1) * hLen);
  }

  return dk.subarray(0, dkLen);
}

/** Convenience: PBKDF2 over UTF-8 strings, returned as hex. */
export function pbkdf2Hex(
  hash: HashAlgorithm,
  password: string,
  salt: string,
  iterations: number,
  dkLen: number,
): string {
  return bytesToHex(pbkdf2(hash, utf8ToBytes(password), utf8ToBytes(salt), iterations, dkLen));
}
