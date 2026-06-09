/**
 * HashAlgorithm — the abstraction every concrete digest implements.
 *
 * HMAC and the password schemes depend on this interface rather than on a
 * specific digest (Dependency Inversion). Adding SHA-512 later is then a pure
 * addition: implement the interface, and HMAC/PBKDF2 work with it unchanged.
 */
export interface HashAlgorithm {
  /** Internal block size in bytes (the unit HMAC pads the key to). */
  readonly blockSize: number;
  /** Digest length in bytes. */
  readonly digestSize: number;
  /** Compute the raw digest of `input`. Must not mutate `input`. */
  digest(input: Uint8Array): Uint8Array;
}
