/**
 * Real cryptographic primitives for the simulator.
 *
 * Historically the simulator faked crypto with non-cryptographic hashes
 * (FNV/Murmur via `Math.imul`) and even plaintext dressed up as ciphertext.
 * This module replaces those with faithful, test-vector-verified algorithms
 * so that on-wire and on-screen artefacts (SSH fingerprints, hashed
 * known_hosts, Cisco type-7 secrets, …) match what real devices emit.
 *
 * Layout:
 *   encoding/   bytes ↔ hex / base64 / utf-8
 *   hash/       md5, sha1, sha256 (+ the HashAlgorithm abstraction)
 *   mac/        hmac (parameterised by any HashAlgorithm)
 *   kdf/        pbkdf2, prf+, scrypt
 *   cipher/     AES (FIPS-197) + AES-CBC
 *   passwords/  vendor password schemes (Cisco type-7/8/9, md5crypt, Huawei, …)
 */

export * from './encoding';
export * from './hash';
export * from './mac';
export * from './kdf';
export * from './cipher';
export * from './passwords';
