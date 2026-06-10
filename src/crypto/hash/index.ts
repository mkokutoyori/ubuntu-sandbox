/**
 * Hash function barrel.
 *
 * Each digest exports a raw `fn(bytes) -> bytes`, a `*Hex(text)` convenience,
 * and a `HashAlgorithm` descriptor consumed by HMAC and the password schemes.
 */
<<<<<<< HEAD
export type { HashAlgorithm, IncrementalHash } from './HashAlgorithm';
=======
export type { HashAlgorithm, ResumableHashAlgorithm } from './HashAlgorithm';
export { isResumable } from './HashAlgorithm';
>>>>>>> origin/claude/happy-volta-51l0hy
export { sha256, sha256Hex, SHA256 } from './sha256';
export { md5, md5Hex, MD5 } from './md5';
export { sha1, sha1Hex, SHA1 } from './sha1';
export { sha512, sha512Hex, SHA512 } from './sha512';
