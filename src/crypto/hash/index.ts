/**
 * Hash function barrel.
 *
 * Each digest exports a raw `fn(bytes) -> bytes`, a `*Hex(text)` convenience,
 * and a `HashAlgorithm` descriptor consumed by HMAC and the password schemes.
 */
export type { HashAlgorithm } from './HashAlgorithm';
export { sha256, sha256Hex, SHA256 } from './sha256';
export { md5, md5Hex, MD5 } from './md5';
export { sha1, sha1Hex, SHA1 } from './sha1';
