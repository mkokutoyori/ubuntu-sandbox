/**
 * SHA-512 (FIPS 180-4) — dependency-free implementation using 32-bit hi/lo
 * word pairs (JavaScript has no native 64-bit bitwise ops). Fast enough to
 * back PBKDF2-HMAC-SHA512 (Oracle 12c verifier, 4096 rounds).
 */

import { utf8ToBytes, bytesToHex } from '../encoding';
import type { ResumableHashAlgorithm } from './HashAlgorithm';

const BLOCK_SIZE = 128; // 1024 bits
const DIGEST_SIZE = 64; // 512 bits

// Round constants (first 64 bits of the fractional parts of the cube roots of
// the first 80 primes), split into hi/lo 32-bit halves.
const K_HI = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  0xca273ece, 0xd186b8c7, 0xeada7dd6, 0xf57d4f7f, 0x06f067aa, 0x0a637dc5, 0x113f9804, 0x1b710b35,
  0x28db77f5, 0x32caab7b, 0x3c9ebe0a, 0x431d67c4, 0x4cc5d4be, 0x597f299c, 0x5fcb6fab, 0x6c44198c,
]);
const K_LO = new Uint32Array([
  0xd728ae22, 0x23ef65cd, 0xec4d3b2f, 0x8189dbbc, 0xf348b538, 0xb605d019, 0xaf194f9b, 0xda6d8118,
  0xa3030242, 0x45706fbe, 0x4ee4b28c, 0xd5ffb4e2, 0xf27b896f, 0x3b1696b1, 0x25c71235, 0xcf692694,
  0x9ef14ad2, 0x384f25e3, 0x8b8cd5b5, 0x77ac9c65, 0x592b0275, 0x6ea6e483, 0xbd41fbd4, 0x831153b5,
  0xee66dfab, 0x2db43210, 0x98fb213f, 0xbeef0ee4, 0x3da88fc2, 0x930aa725, 0xe003826f, 0x0a0e6e70,
  0x46d22ffc, 0x5c26c926, 0x5ac42aed, 0x9d95b3df, 0x8baf63de, 0x3c77b2a8, 0x47edaee6, 0x1482353b,
  0x4cf10364, 0xbc423001, 0xd0f89791, 0x0654be30, 0xd6ef5218, 0x5565a910, 0x5771202a, 0x32bbd1b8,
  0xb8d2d0c8, 0x5141ab53, 0xdf8eeb99, 0xe19b48a8, 0xc5c95a63, 0xe3418acb, 0x7763e373, 0xd6b2b8a3,
  0x5defb2fc, 0x43172f60, 0xa1f0ab72, 0x1a6439ec, 0x23631e28, 0xde82bde9, 0xb2c67915, 0xe372532b,
  0xea26619c, 0x21c0c207, 0xcde0eb1e, 0xee6ed178, 0x72176fba, 0xa2c898a6, 0xbef90dae, 0x131c471b,
  0x23047d84, 0x40c72493, 0x15c9bebc, 0x9c100d4c, 0xcb3e42b6, 0xfc657e2a, 0x3ad6faec, 0x4a475817,
]);

/** Initial hash values (fractional parts of the square roots of the first 8 primes). */
function initState(): Uint32Array {
  return new Uint32Array([
    0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
  ]);
}

// Message-schedule scratch buffers, shared across calls (single-threaded JS;
// compressBlocks never re-enters itself).
const SCRATCH_WH = new Uint32Array(80);
const SCRATCH_WL = new Uint32Array(80);

/** Absorb full 128-byte blocks into the chaining state `h`. */
function compressBlocks(h: Uint32Array, data: Uint8Array): void {
  const wh = SCRATCH_WH;
  const wl = SCRATCH_WL;

  for (let off = 0; off < data.length; off += BLOCK_SIZE) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 8;
      wh[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
      wl[i] = (data[j + 4] << 24) | (data[j + 5] << 16) | (data[j + 6] << 8) | data[j + 7];
    }
    for (let i = 16; i < 80; i++) {
      // s0 = rotr(w[i-15],1) ^ rotr(w[i-15],8) ^ shr(w[i-15],7)
      const x15h = wh[i - 15], x15l = wl[i - 15];
      const s0h = (rotrH(x15h, x15l, 1) ^ rotrH(x15h, x15l, 8) ^ shrH(x15h, 7)) >>> 0;
      const s0l = (rotrL(x15h, x15l, 1) ^ rotrL(x15h, x15l, 8) ^ shrL(x15h, x15l, 7)) >>> 0;
      // s1 = rotr(w[i-2],19) ^ rotr(w[i-2],61) ^ shr(w[i-2],6)
      const x2h = wh[i - 2], x2l = wl[i - 2];
      const s1h = (rotrH(x2h, x2l, 19) ^ rotrH(x2h, x2l, 61) ^ shrH(x2h, 6)) >>> 0;
      const s1l = (rotrL(x2h, x2l, 19) ^ rotrL(x2h, x2l, 61) ^ shrL(x2h, x2l, 6)) >>> 0;

      const lo = (wl[i - 16] >>> 0) + s0l + (wl[i - 7] >>> 0) + s1l;
      const hi = (wh[i - 16] >>> 0) + s0h + (wh[i - 7] >>> 0) + s1h + Math.floor(lo / 0x100000000);
      wl[i] = lo >>> 0;
      wh[i] = hi >>> 0;
    }

    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];

    for (let i = 0; i < 80; i++) {
      const S1h = (rotrH(eh, el, 14) ^ rotrH(eh, el, 18) ^ rotrH(eh, el, 41)) >>> 0;
      const S1l = (rotrL(eh, el, 14) ^ rotrL(eh, el, 18) ^ rotrL(eh, el, 41)) >>> 0;
      const chh = ((eh & fh) ^ (~eh & gh)) >>> 0;
      const chl = ((el & fl) ^ (~el & gl)) >>> 0;

      const t1l = (hl >>> 0) + S1l + chl + (K_LO[i] >>> 0) + (wl[i] >>> 0);
      const t1h = (hh >>> 0) + S1h + chh + (K_HI[i] >>> 0) + (wh[i] >>> 0) + Math.floor(t1l / 0x100000000);

      const S0h = (rotrH(ah, al, 28) ^ rotrH(ah, al, 34) ^ rotrH(ah, al, 39)) >>> 0;
      const S0l = (rotrL(ah, al, 28) ^ rotrL(ah, al, 34) ^ rotrL(ah, al, 39)) >>> 0;
      const majh = ((ah & bh) ^ (ah & ch) ^ (bh & ch)) >>> 0;
      const majl = ((al & bl) ^ (al & cl) ^ (bl & cl)) >>> 0;

      const t2l = S0l + majl;
      const t2h = S0h + majh + Math.floor(t2l / 0x100000000);

      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const newEl = (dl >>> 0) + (t1l >>> 0);
      const newEh = (dh >>> 0) + (t1h >>> 0) + Math.floor(newEl / 0x100000000);
      eh = newEh >>> 0; el = newEl >>> 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const newAl = (t1l >>> 0) + (t2l >>> 0);
      const newAh = (t1h >>> 0) + (t2h >>> 0) + Math.floor(newAl / 0x100000000);
      ah = newAh >>> 0; al = newAl >>> 0;
    }

    // Fold working vars back into the hash (with 64-bit carry).
    addInto(h, 0, ah, al);
    addInto(h, 2, bh, bl);
    addInto(h, 4, ch, cl);
    addInto(h, 6, dh, dl);
    addInto(h, 8, eh, el);
    addInto(h, 10, fh, fl);
    addInto(h, 12, gh, gl);
    addInto(h, 14, hh, hl);
  }
}

/** Serialize the chaining state into the 64-byte big-endian digest. */
function serializeState(h: Uint32Array): Uint8Array {
  const out = new Uint8Array(DIGEST_SIZE);
  for (let i = 0; i < 16; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

/**
 * Pad and absorb the final `tail`, given the total number of message bytes
 * absorbed overall (already-compressed prefix + tail), then serialize.
 */
function finalizeState(h: Uint32Array, tail: Uint8Array, totalLen: number): Uint8Array {
  compressBlocks(h, padTail(tail, totalLen));
  return serializeState(h);
}

/** Compute the raw 64-byte SHA-512 digest of `input` (input is not mutated). */
export function sha512(input: Uint8Array): Uint8Array {
  return finalizeState(initState(), input, input.length);
}

/** Hex digest of a UTF-8 string. */
export function sha512Hex(text: string): string {
  return bytesToHex(sha512(utf8ToBytes(text)));
}

export const SHA512: ResumableHashAlgorithm = {
  blockSize: BLOCK_SIZE,
  digestSize: DIGEST_SIZE,
  digest: sha512,
  initState,
  compressBlocks,
  finalizeState,
};

// ─── 64-bit helpers operating on hi/lo 32-bit halves ─────────────────────

function rotrH(xh: number, xl: number, n: number): number {
  if (n === 32) return xl;
  if (n < 32) return (xh >>> n) | (xl << (32 - n));
  return (xl >>> (n - 32)) | (xh << (64 - n));
}
function rotrL(xh: number, xl: number, n: number): number {
  if (n === 32) return xh;
  if (n < 32) return (xl >>> n) | (xh << (32 - n));
  return (xh >>> (n - 32)) | (xl << (64 - n));
}
function shrH(xh: number, n: number): number {
  return n < 32 ? xh >>> n : 0;
}
function shrL(xh: number, xl: number, n: number): number {
  return n < 32 ? (xl >>> n) | (xh << (32 - n)) : xh >>> (n - 32);
}

/** Add a 64-bit value (vh,vl) into the hash word pair at index i (with carry). */
function addInto(h: Uint32Array, i: number, vh: number, vl: number): void {
  const lo = (h[i + 1] >>> 0) + (vl >>> 0);
  const hi = (h[i] >>> 0) + (vh >>> 0) + Math.floor(lo / 0x100000000);
  h[i] = hi >>> 0;
  h[i + 1] = lo >>> 0;
}

/**
 * Pad the final chunk: 0x80, zeros, then the 128-bit big-endian *total*
 * message bit length, so the result is a whole number of 128-byte blocks.
 */
function padTail(tail: Uint8Array, totalLen: number): Uint8Array {
  const paddedLen = (((tail.length + 16) >> 7) + 1) * 128;
  const padded = new Uint8Array(paddedLen);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const bitLen = totalLen * 8;
  const dv = new DataView(padded.buffer);
  // High 64 bits of the length are always 0 for our message sizes.
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(paddedLen - 4, bitLen >>> 0);
  return padded;
}
