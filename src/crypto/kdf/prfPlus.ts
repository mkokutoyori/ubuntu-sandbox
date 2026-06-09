/**
 * PRF+ (RFC 5996 §2.13) — iterated-PRF key-material expansion.
 *
 * IKEv2 derives all SA keys from a single shared secret via:
 *
 *   prf+(K,S) = T1 | T2 | T3 | …
 *     T1 = prf(K, S | 0x01)
 *     Tn = prf(K, T(n-1) | S | n)        (n encoded as one octet)
 *
 * Parameterised by a {@link HashAlgorithm} (used as the HMAC PRF) so it can
 * back any IKE transform. Used here to derive deterministic, peer-shared
 * IPSec KEYMAT instead of the previous `Math.random()` stand-in.
 */

import type { HashAlgorithm } from '../hash';
import { hmac } from '../mac';

/**
 * Expand `key`/`seed` into exactly `bytes` octets of key material.
 *
 * @throws if `bytes` is not a positive integer, or if more than 255 PRF
 *         blocks would be required (the single-octet counter overflows).
 */
export function prfPlus(
  hash: HashAlgorithm,
  key: Uint8Array,
  seed: Uint8Array,
  bytes: number,
): Uint8Array {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`prfPlus: bytes must be a positive integer (got ${bytes})`);
  }
  const out = new Uint8Array(bytes);
  let filled = 0;
  let prev = new Uint8Array(0);
  let counter = 1;

  while (filled < bytes) {
    if (counter > 0xff) {
      throw new Error('prfPlus: requested length exceeds 255 PRF blocks');
    }
    // T(n) = prf(key, T(n-1) | seed | n)
    const input = new Uint8Array(prev.length + seed.length + 1);
    input.set(prev, 0);
    input.set(seed, prev.length);
    input[input.length - 1] = counter;

    prev = hmac(hash, key, input);
    const take = Math.min(prev.length, bytes - filled);
    out.set(prev.subarray(0, take), filled);
    filled += take;
    counter++;
  }

  return out;
}
