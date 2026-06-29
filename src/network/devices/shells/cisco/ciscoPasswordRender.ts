/**
 * Cisco secret/password rendering for `show running-config`.
 *
 * Real IOS never echoes a cleartext password back in the config: an
 * `enable secret` is stored as an md5crypt ($1$) hash, and with `service
 * password-encryption` even the reversible line/enable passwords are shown
 * type-7 encoded. These pure helpers reproduce that, backed by the genuine
 * algorithms in `@/crypto`, so the simulator stops leaking plaintext.
 */

import { md5Crypt, ciscoType8, ciscoType9, encryptType7, md5Hex } from '@/crypto';

export type SecretAlgo = 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';

/** Map a modular-crypt prefix to the Cisco "type" number IOS prints for it. */
function cryptPrefixType(value: string): number | null {
  if (value.startsWith('$1$')) return 5; // md5crypt
  if (value.startsWith('$8$')) return 8; // pbkdf2-sha256
  if (value.startsWith('$9$')) return 9; // scrypt
  return null;
}

/**
 * Render the `<type-number> <value>` suffix of an `enable secret` /
 * `username … secret` line. Plaintext is hashed with the real algorithm for
 * its type (md5crypt for type-5, PBKDF2 for type-8); values already in
 * modular-crypt form pass through under their own type number.
 */
export function renderSecretField(value: string, algo: SecretAlgo): string {
  const preHashed = cryptPrefixType(value);
  if (preHashed !== null) return `${preHashed} ${value}`;
  switch (algo) {
    case 'md5':
      return `5 ${md5Crypt(value, deriveCryptSalt(value))}`;
    case 'sha256':
      return `8 ${ciscoType8(value, deriveType8Salt(value))}`; // PBKDF2-HMAC-SHA256
    case 'scrypt':
      return `9 ${ciscoType9(value, deriveType9Salt(value))}`;
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
  return value;
}

/**
 * Deterministic 8-char salt drawn from the crypt alphabet (hex is a subset).
 * Real IOS randomises it; the simulator favours stable, reproducible output.
 */
function deriveCryptSalt(seed: string): string {
  return md5Hex(`cisco-secret:${seed}`).slice(0, 8);
}

/** Deterministic 14-char type-8 salt (hex is a subset of the crypt alphabet). */
function deriveType8Salt(seed: string): string {
  return md5Hex(`cisco-type8:${seed}`).slice(0, 14);
}

/** Deterministic 14-char type-9 (scrypt) salt. */
function deriveType9Salt(seed: string): string {
  return md5Hex(`cisco-type9:${seed}`).slice(0, 14);
}

/** Deterministic type-7 key offset in [0, 15] derived from the secret. */
function deriveType7Salt(seed: string): number {
  return Number.parseInt(md5Hex(`cisco-type7:${seed}`).slice(0, 1), 16);
}
