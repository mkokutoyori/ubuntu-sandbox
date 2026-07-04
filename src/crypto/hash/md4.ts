/**
 * MD4 (RFC 1320) — dependency-free implementation.
 *
 * Provided solely as the building block for MS-CHAPv2's NT-Password-Hash
 * (RFC 2759 §8.1: `MD4(UTF-16LE(password))`) — MD4 itself is cryptographically
 * broken and must never be used for anything the simulator treats as secure.
 * Same little-endian padding scheme as `md5.ts` (RFC 1320 and RFC 1321 share
 * it verbatim); only the round functions/constants/message-word order differ.
 */

const BLOCK_SIZE = 64;

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

/** Round 2 processes message words in this order (RFC 1320 §3.4). */
const ORDER2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
/** Round 3 processes message words in this order (RFC 1320 §3.4). */
const ORDER3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const SHIFT1 = [3, 7, 11, 19];
const SHIFT2 = [3, 5, 9, 13];
const SHIFT3 = [3, 9, 11, 15];
const K2 = 0x5a827999;
const K3 = 0x6ed9eba1;

/** Compute the raw 16-byte MD4 digest of `input` (input is not mutated). */
export function md4(input: Uint8Array): Uint8Array {
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const padded = padMessage(input);
  const m = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      m[i] = padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }

    let a = a0, b = b0, c = c0, d = d0;

    for (let i = 0; i < 16; i++) {
      const f = (b & c) | (~b & d);
      const temp = rotl((a + f + m[i]) >>> 0, SHIFT1[i % 4]);
      a = d; d = c; c = b; b = temp;
    }
    for (let i = 0; i < 16; i++) {
      const f = (b & c) | (b & d) | (c & d);
      const temp = rotl((a + f + m[ORDER2[i]] + K2) >>> 0, SHIFT2[i % 4]);
      a = d; d = c; c = b; b = temp;
    }
    for (let i = 0; i < 16; i++) {
      const f = b ^ c ^ d;
      const temp = rotl((a + f + m[ORDER3[i]] + K3) >>> 0, SHIFT3[i % 4]);
      a = d; d = c; c = b; b = temp;
    }

    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }

  return wordsToBytesLE([a0, b0, c0, d0]);
}

/** Append the 0x80 byte, zero pad to ≡56 (mod 64), then the 64-bit LE bit length — identical to MD5's scheme. */
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
