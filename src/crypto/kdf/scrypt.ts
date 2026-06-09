/**
 * scrypt (RFC 7914) — the memory-hard password-based KDF behind Cisco type-9.
 *
 * Pure 32-bit-word implementation (Salsa20/8 core → BlockMix → ROMix), built
 * on the PBKDF2-HMAC-SHA256 in this module. Working buffers are pre-allocated
 * and reused; the dominant cost is the N·128·r-byte ROMix array.
 */

import { pbkdf2 } from './pbkdf2';
import { SHA256 } from '../hash';
import { utf8ToBytes, bytesToHex } from '../encoding';

/** Derive `dkLen` bytes via scrypt. @throws on invalid cost parameters. */
export function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number,
): Uint8Array {
  if (N < 2 || (N & (N - 1)) !== 0) {
    throw new Error(`scrypt: N must be a power of two > 1 (got ${N})`);
  }
  if (r <= 0 || p <= 0 || dkLen <= 0) {
    throw new Error('scrypt: r, p and dkLen must be positive');
  }

  const blockWords = 32 * r; // words per 128*r-byte block
  const b = pbkdf2(SHA256, password, salt, 1, p * 128 * r);
  const B = bytesToWordsLE(b); // p * blockWords words

  const V = new Uint32Array(N * blockWords);
  const X = new Uint32Array(blockWords);
  const Y = new Uint32Array(blockWords);
  for (let i = 0; i < p; i++) {
    roMix(B, i * blockWords, N, r, V, X, Y);
  }

  return pbkdf2(SHA256, password, wordsToBytesLE(B), 1, dkLen);
}

/** Convenience: scrypt over UTF-8 strings, returned as hex. */
export function scryptHex(
  password: string,
  salt: string,
  N: number,
  r: number,
  p: number,
  dkLen: number,
): string {
  return bytesToHex(scrypt(utf8ToBytes(password), utf8ToBytes(salt), N, r, p, dkLen));
}

/** ROMix (RFC 7914 §5) on the block at `B[off .. off+32r]`, in place. */
function roMix(B: Uint32Array, off: number, N: number, r: number, V: Uint32Array, X: Uint32Array, Y: Uint32Array): void {
  const blockWords = 32 * r;
  for (let i = 0; i < blockWords; i++) X[i] = B[off + i];

  for (let i = 0; i < N; i++) {
    V.set(X, i * blockWords);
    blockMix(X, Y, r);
  }
  for (let i = 0; i < N; i++) {
    const j = X[(2 * r - 1) * 16] & (N - 1); // Integerify mod N
    for (let k = 0; k < blockWords; k++) X[k] ^= V[j * blockWords + k];
    blockMix(X, Y, r);
  }

  for (let i = 0; i < blockWords; i++) B[off + i] = X[i];
}

/** BlockMix (RFC 7914 §4): mixes 2r 64-byte sub-blocks of B in place via Y. */
function blockMix(B: Uint32Array, Y: Uint32Array, r: number): void {
  const X = new Uint32Array(16);
  for (let i = 0; i < 16; i++) X[i] = B[(2 * r - 1) * 16 + i];

  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
    salsa20_8(X);
    Y.set(X, i * 16);
  }
  // Reorder: Y0, Y2, …, Y(2r-2), Y1, Y3, …, Y(2r-1)
  for (let i = 0; i < r; i++) {
    B.set(Y.subarray((2 * i) * 16, (2 * i) * 16 + 16), i * 16);
    B.set(Y.subarray((2 * i + 1) * 16, (2 * i + 1) * 16 + 16), (r + i) * 16);
  }
}

const rotl = (a: number, b: number): number => (a << b) | (a >>> (32 - b));

/** Salsa20/8 core (RFC 7914 §3) on a 16-word block, in place. */
function salsa20_8(B: Uint32Array): void {
  const x = new Uint32Array(16);
  for (let i = 0; i < 16; i++) x[i] = B[i];

  for (let round = 0; round < 8; round += 2) {
    x[4] ^= rotl((x[0] + x[12]) | 0, 7);   x[8] ^= rotl((x[4] + x[0]) | 0, 9);
    x[12] ^= rotl((x[8] + x[4]) | 0, 13);  x[0] ^= rotl((x[12] + x[8]) | 0, 18);
    x[9] ^= rotl((x[5] + x[1]) | 0, 7);    x[13] ^= rotl((x[9] + x[5]) | 0, 9);
    x[1] ^= rotl((x[13] + x[9]) | 0, 13);  x[5] ^= rotl((x[1] + x[13]) | 0, 18);
    x[14] ^= rotl((x[10] + x[6]) | 0, 7);  x[2] ^= rotl((x[14] + x[10]) | 0, 9);
    x[6] ^= rotl((x[2] + x[14]) | 0, 13);  x[10] ^= rotl((x[6] + x[2]) | 0, 18);
    x[3] ^= rotl((x[15] + x[11]) | 0, 7);  x[7] ^= rotl((x[3] + x[15]) | 0, 9);
    x[11] ^= rotl((x[7] + x[3]) | 0, 13);  x[15] ^= rotl((x[11] + x[7]) | 0, 18);

    x[1] ^= rotl((x[0] + x[3]) | 0, 7);    x[2] ^= rotl((x[1] + x[0]) | 0, 9);
    x[3] ^= rotl((x[2] + x[1]) | 0, 13);   x[0] ^= rotl((x[3] + x[2]) | 0, 18);
    x[6] ^= rotl((x[5] + x[4]) | 0, 7);    x[7] ^= rotl((x[6] + x[5]) | 0, 9);
    x[4] ^= rotl((x[7] + x[6]) | 0, 13);   x[5] ^= rotl((x[4] + x[7]) | 0, 18);
    x[11] ^= rotl((x[10] + x[9]) | 0, 7);  x[8] ^= rotl((x[11] + x[10]) | 0, 9);
    x[9] ^= rotl((x[8] + x[11]) | 0, 13);  x[10] ^= rotl((x[9] + x[8]) | 0, 18);
    x[12] ^= rotl((x[15] + x[14]) | 0, 7); x[13] ^= rotl((x[12] + x[15]) | 0, 9);
    x[14] ^= rotl((x[13] + x[12]) | 0, 13); x[15] ^= rotl((x[14] + x[13]) | 0, 18);
  }

  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

function bytesToWordsLE(bytes: Uint8Array): Uint32Array {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = (bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)) >>> 0;
  }
  return words;
}

function wordsToBytesLE(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    bytes[i * 4] = words[i] & 0xff;
    bytes[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    bytes[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    bytes[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return bytes;
}
