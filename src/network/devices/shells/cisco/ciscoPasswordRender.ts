/**
 * Cisco secret/password rendering for `show running-config`.
 *
 * Real IOS never echoes a cleartext password back in the config: an
 * `enable secret` is stored as an md5crypt ($1$) hash, and with `service
 * password-encryption` even the reversible line/enable passwords are shown
 * type-7 encoded. These pure helpers reproduce that, backed by the genuine
 * algorithms in `@/crypto`, so the simulator stops leaking plaintext.
 */

import { md5Crypt, encryptType7, md5Hex } from '@/crypto';

/** A value already in modular-crypt form ("$1$…", "$5$…", "$6$…"). */
const CRYPT_PREFIX = /^\$\d+\$/;

export type SecretAlgo = 'plain' | 'md5' | 'sha256' | 'type-7';

/**
 * Render the `<type-number> <value>` suffix of an `enable secret` /
 * `username … secret` line. A plaintext md5 secret becomes a real md5crypt
 * hash; pre-hashed and other-typed values pass through untouched.
 */
export function renderSecretField(value: string, algo: SecretAlgo): string {
  if (CRYPT_PREFIX.test(value)) return `5 ${value}`;
  switch (algo) {
    case 'md5':
      return `5 ${md5Crypt(value, deriveCryptSalt(value))}`;
    case 'sha256':
      // PBKDF2 (type 8) / scrypt (type 9) are not modelled yet — pass through.
      return `8 ${value}`;
    case 'type-7':
      return `7 ${value}`;
    default:
      return `0 ${value}`;
  }
}

/**
 * Render the `<type-number> <value>` suffix of an `enable password` / line
 * `password`. Plaintext is type-7 encoded when `service password-encryption`
 * is enabled; an already type-7 value is emitted verbatim.
 */
export function renderPasswordField(
  value: string,
  algo: 'plain' | 'type-7',
  serviceEncryption: boolean,
): string {
  if (algo === 'type-7') return `7 ${value}`;
  if (serviceEncryption) return `7 ${encryptType7(value, deriveType7Salt(value))}`;
  return `0 ${value}`;
}

/**
 * Deterministic 8-char salt drawn from the crypt alphabet (hex is a subset).
 * Real IOS randomises it; the simulator favours stable, reproducible output.
 */
function deriveCryptSalt(seed: string): string {
  return md5Hex(`cisco-secret:${seed}`).slice(0, 8);
}

/** Deterministic type-7 key offset in [0, 15] derived from the secret. */
function deriveType7Salt(seed: string): number {
  return Number.parseInt(md5Hex(`cisco-type7:${seed}`).slice(0, 1), 16);
}
