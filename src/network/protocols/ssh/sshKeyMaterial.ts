/**
 * Deterministic SSH key-material derivation.
 *
 * The simulator does not implement real Ed25519/RSA keypairs, but it should
 * not fabricate key blobs with a non-cryptographic FNV hash either. This
 * derives stable, base64-shaped material from a seed using SHA-256 in
 * counter mode (a minimal MGF1-style expansion), so the same seed always
 * yields the same material and distinct seeds avalanche apart.
 */

import { sha256, bytesToBase64, utf8ToBytes } from '@/crypto';

/**
 * Produce `length` base64 characters of deterministic key material for `seed`.
 * Successive SHA-256 blocks (`seed#0`, `seed#1`, …) are base64-encoded,
 * stripped of padding, and concatenated until `length` is reached.
 */
export function deriveKeyMaterial(seed: string, length: number): string {
  let out = '';
  let counter = 0;
  while (out.length < length) {
    out += bytesToBase64(sha256(utf8ToBytes(`${seed}#${counter}`))).replace(/=+$/, '');
    counter++;
  }
  return out.slice(0, length);
}
