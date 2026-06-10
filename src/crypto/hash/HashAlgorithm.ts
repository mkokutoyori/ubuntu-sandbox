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

/**
 * Optional capability: expose the Merkle–Damgård chaining state so callers
 * can absorb a fixed prefix once and resume from copies of that state.
 *
 * PBKDF2 exploits this for its HMAC inner loop — the two key-pad blocks are
 * compressed once instead of on every one of the thousands of iterations,
 * roughly halving the compression count.
 */
export interface ResumableHashAlgorithm extends HashAlgorithm {
  /** Fresh initial chaining state (the algorithm's IV words). */
  initState(): Uint32Array;
  /** Absorb full blocks (`blocks.length` must be a multiple of `blockSize`). */
  compressBlocks(state: Uint32Array, blocks: Uint8Array): void;
  /**
   * Pad and absorb the final `tail`, given the total number of message bytes
   * absorbed overall (prefix blocks + tail), and serialize the digest.
   */
  finalizeState(state: Uint32Array, tail: Uint8Array, totalLen: number): Uint8Array;
}

export function isResumable(hash: HashAlgorithm): hash is ResumableHashAlgorithm {
  const candidate = hash as ResumableHashAlgorithm;
  return typeof candidate.initState === 'function'
    && typeof candidate.compressBlocks === 'function'
    && typeof candidate.finalizeState === 'function';
}
