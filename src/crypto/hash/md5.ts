/**
 * MD5 (RFC 1321) — a faithful, dependency-free implementation.
 *
 * Little-endian throughout (the MD5 quirk). Pure 32-bit arithmetic via
 * `Math.imul` / `>>> 0`. Provided because the simulator must reproduce the
 * real wire format of Cisco type-5, HMAC-MD5 and Unix `$1$` crypt.
 */

import { utf8ToBytes, bytesToHex } from '../encoding';
import type { HashAlgorithm } from './HashAlgorithm';

const BLOCK_SIZE = 64;
const DIGEST_SIZE = 16;

/** Per-round left-rotation amounts (RFC 1321 §3.4). */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** Additive constants K[i] = floor(2^32 * abs(sin(i + 1))). */
const K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

/** Compute the raw 16-byte MD5 digest of `input` (input is not mutated). */
export function md5(input: Uint8Array): Uint8Array {
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const padded = padMessage(input);
  const m = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
    // Decode the block as 16 little-endian 32-bit words.
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      m[i] = padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }

    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }

      f = (f + a + K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + rotl(f, S[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }

  return wordsToBytesLE([a0, b0, c0, d0]);
}

/** Hex digest of a UTF-8 string. */
export function md5Hex(text: string): string {
  return bytesToHex(md5(utf8ToBytes(text)));
}

/** Algorithm descriptor for HMAC-MD5 / $1$ crypt. */
export const MD5: HashAlgorithm = {
  blockSize: BLOCK_SIZE,
  digestSize: DIGEST_SIZE,
  digest: md5,
};

/** Append the 0x80 byte, zero pad to ≡56 (mod 64), then the 64-bit LE bit length. */
function padMessage(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const paddedLen = ((input.length + 8) >> 6) * 64 + 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  return padded;
}

function wordsToBytesLE(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}
