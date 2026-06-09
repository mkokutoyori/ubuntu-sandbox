/**
 * Derives the password verifiers Oracle stores in SYS.USER$ from the
 * simulator's plaintext password, using the real algorithms in `@/crypto`.
 *
 * Real Oracle salts randomly; the simulator derives the salt deterministically
 * from the credentials so a given account always renders the same verifier
 * (stable `SELECT … FROM SYS.USER$` output) without leaking the cleartext.
 */

import {
  oracle10gHash, oracle11gVerifier, oracle12cVerifier, sha1, sha256, utf8ToBytes,
} from '@/crypto';

export interface OracleStoredVerifiers {
  /** Legacy 10g hash (SYS.USER$.PASSWORD) — 16 uppercase hex. */
  readonly password: string;
  /** 11g `S:` + 12c `T:` verifiers, `;`-joined (SYS.USER$.SPARE4). */
  readonly spare4: string;
}

/** Compute the 10g/11g/12c verifiers for a username + plaintext password. */
export function deriveStoredVerifiers(username: string, password: string): OracleStoredVerifiers {
  const salt11 = sha1(utf8ToBytes(`ora11g:${username}:${password}`)).subarray(0, 10);
  const salt12 = sha256(utf8ToBytes(`ora12c:${username}:${password}`)).subarray(0, 16);
  return {
    password: oracle10gHash(username, password),
    spare4: `${oracle11gVerifier(password, salt11)};${oracle12cVerifier(password, salt12)}`,
  };
}
