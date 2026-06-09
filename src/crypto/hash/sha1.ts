/**
 * SHA-1 (FIPS 180-1 / RFC 3174) — a faithful, dependency-free implementation.
 *
 * Big-endian, 80-round compression. Like MD5, SHA-1 is collision-broken but
 * remains the format reality for OpenSSH hashed known_hosts and IKE hmac-sha-1.
 */

import { utf8ToBytes, bytesToHex } from '../encoding';
import type { HashAlgorithm } from './HashAlgorithm';

const BLOCK_SIZE = 64;
const DIGEST_SIZE = 20;

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

/** Compute the raw 20-byte SHA-1 digest of `input` (input is not mutated). */
export function sha1(input: Uint8Array): Uint8Array {
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

  const padded = padMessage(input);
  const w = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }

      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  return wordsToBytes([h0, h1, h2, h3, h4]);
}

/** Hex digest of a UTF-8 string. */
export function sha1Hex(text: string): string {
  return bytesToHex(sha1(utf8ToBytes(text)));
}

/** Algorithm descriptor for HMAC-SHA1. */
export const SHA1: HashAlgorithm = {
  blockSize: BLOCK_SIZE,
  digestSize: DIGEST_SIZE,
  digest: sha1,
};

/** Append the 0x80 byte, zero pad to ≡56 (mod 64), then the 64-bit BE bit length. */
function padMessage(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const paddedLen = ((input.length + 8) >> 6) * 64 + 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(paddedLen - 4, bitLen >>> 0);
  return padded;
}

function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    out[i * 4] = (words[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 3] = words[i] & 0xff;
  }
  return out;
}
