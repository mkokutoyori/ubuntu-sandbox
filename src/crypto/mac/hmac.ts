/**
 * HMAC (RFC 2104) — keyed-hash message authentication.
 *
 * Parameterised by a {@link HashAlgorithm} so a single implementation backs
 * HMAC-MD5, HMAC-SHA1 and HMAC-SHA256. Used by the real OpenSSH hashed
 * known_hosts token and IKE/IPSec integrity transforms.
 */

import type { HashAlgorithm, IncrementalHash } from '../hash';
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

/**
 * Keyed HMAC engine with precomputed key-pad midstates.
 *
 * One-shot {@link hmac} re-hashes the padded key blocks on every call, which
 * is wasteful when the same key signs thousands of messages (PBKDF2 runs one
 * HMAC per round). When the hash exposes an incremental state, the ipad and
 * opad blocks are compressed once here, and each digest only hashes the
 * message itself — two compressions per call instead of four-plus.
 */
export class PrecomputedHmac {
  private readonly inner: IncrementalHash;
  private readonly outer: IncrementalHash;

  private constructor(inner: IncrementalHash, outer: IncrementalHash) {
    this.inner = inner;
    this.outer = outer;
  }

  /** Build an engine for `key`, or null when the hash is one-shot only. */
  static create(hash: HashAlgorithm, key: Uint8Array): PrecomputedHmac | null {
    if (!hash.createState) return null;
    const blockKey = normalizeKey(hash, key);
    const ipadBlock = new Uint8Array(hash.blockSize);
    const opadBlock = new Uint8Array(hash.blockSize);
    for (let i = 0; i < hash.blockSize; i++) {
      ipadBlock[i] = blockKey[i] ^ IPAD;
      opadBlock[i] = blockKey[i] ^ OPAD;
    }
    return new PrecomputedHmac(
      hash.createState().update(ipadBlock),
      hash.createState().update(opadBlock),
    );
  }

  /** HMAC(key, message) using the precomputed midstates. */
  digest(message: Uint8Array): Uint8Array {
    const innerDigest = this.inner.clone().update(message).digest();
    return this.outer.clone().update(innerDigest).digest();
  }
}
