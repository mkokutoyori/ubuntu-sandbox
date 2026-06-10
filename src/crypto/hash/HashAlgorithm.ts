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
  /**
   * Create an incremental hashing state (optional). Iteration-heavy
   * consumers (PBKDF2) use it to precompute the HMAC key-pad midstates
   * once and re-hash only the per-round message, which removes most of
   * the per-round compressions and allocations.
   */
  createState?(): IncrementalHash;
}

/**
 * Streaming digest state: absorb bytes with {@link update}, snapshot with
 * {@link clone}, and finalize with {@link digest}. `digest()` must leave the
 * state usable (finalization happens on an internal copy) so a precomputed
 * midstate can be reused across many messages.
 */
export interface IncrementalHash {
  update(data: Uint8Array): this;
  clone(): IncrementalHash;
  digest(): Uint8Array;
}
