/**
 * HMAC (RFC 2104) — keyed-hash message authentication.
 *
 * Parameterised by a {@link HashAlgorithm} so a single implementation backs
 * HMAC-MD5, HMAC-SHA1 and HMAC-SHA256. Used by the real OpenSSH hashed
 * known_hosts token and IKE/IPSec integrity transforms.
 */

import type { HashAlgorithm } from '../hash';
import { utf8ToBytes, bytesToHex } from '../encoding';

const IPAD = 0x36;
const OPAD = 0x5c;

/**
 * Compute HMAC(message) under `key` using the given hash.
 *
 *   HMAC(K, m) = H((K' ⊕ opad) ‖ H((K' ⊕ ipad) ‖ m))
 *
 * where K' is the key padded/condensed to the hash block size.
 */
export function hmac(hash: HashAlgorithm, key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockKey = normalizeKey(hash, key);

  const inner = new Uint8Array(hash.blockSize + message.length);
  for (let i = 0; i < hash.blockSize; i++) inner[i] = blockKey[i] ^ IPAD;
  inner.set(message, hash.blockSize);
  const innerDigest = hash.digest(inner);

  const outer = new Uint8Array(hash.blockSize + innerDigest.length);
  for (let i = 0; i < hash.blockSize; i++) outer[i] = blockKey[i] ^ OPAD;
  outer.set(innerDigest, hash.blockSize);

  return hash.digest(outer);
}

/** Convenience: HMAC over UTF-8 strings, returned as a hex string. */
export function hmacHex(hash: HashAlgorithm, key: string, message: string): string {
  return bytesToHex(hmac(hash, utf8ToBytes(key), utf8ToBytes(message)));
}

/** Reduce/extend the key to exactly one hash block (RFC 2104 §2). */
function normalizeKey(hash: HashAlgorithm, key: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(hash.blockSize);
  // Keys longer than the block size are first hashed down.
  const condensed = key.length > hash.blockSize ? hash.digest(key) : key;
  blockKey.set(condensed);
  return blockKey;
}
