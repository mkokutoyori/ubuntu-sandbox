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

// The 12c verifier costs a real PBKDF2-SHA512 run (4096 iterations in pure
// TS). The derivation is deterministic per (username, password), so results
// are memoised — otherwise every SELECT on SYS.USER$ re-derives verifiers
// for every account and a 6-row query takes seconds.
const verifierCache = new Map<string, OracleStoredVerifiers>();
const VERIFIER_CACHE_MAX = 1024;

/** Compute the 10g/11g/12c verifiers for a username + plaintext password. */
export function deriveStoredVerifiers(username: string, password: string): OracleStoredVerifiers {
  const cacheKey = `${username}\u0000${password}`;
  const cached = verifierCache.get(cacheKey);
  if (cached) return cached;

  const salt11 = sha1(utf8ToBytes(`ora11g:${username}:${password}`)).subarray(0, 10);
  const salt12 = sha256(utf8ToBytes(`ora12c:${username}:${password}`)).subarray(0, 16);
  const verifiers: OracleStoredVerifiers = {
    password: oracle10gHash(username, password),
    spare4: `${oracle11gVerifier(password, salt11)};${oracle12cVerifier(password, salt12)}`,
  };

  if (verifierCache.size >= VERIFIER_CACHE_MAX) verifierCache.clear();
  verifierCache.set(cacheKey, verifiers);
  return verifiers;
}
