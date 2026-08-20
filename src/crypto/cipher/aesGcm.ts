/**
 * AES-GCM (NIST SP 800-38D) — authenticated encryption built on the FIPS-197
 * block cipher: CTR-mode confidentiality plus a GHASH-based authentication
 * tag, exactly as ESP-GCM (RFC 4106) requires. Only the 96-bit IV case is
 * implemented (the universal case for IPsec/TLS), which lets J0 be formed
 * directly instead of via GHASH-of-the-IV.
 */

import { aesEncryptBlock, AES_BLOCK_SIZE } from './aes';

const TAG_SIZE = 16;

/** XOR two same-length byte arrays. */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Right-shift a 16-byte big-endian value by one bit. */
function shr1(v: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 0; i < 16; i++) {
    out[i] = (v[i] >> 1) | (carry << 7);
    carry = v[i] & 1;
  }
  return out;
}

/** GF(2^128) multiplication per SP 800-38D Algorithm 1 (reduction poly R = 0xE1 || 0^120). */
function gfMul128(x: Uint8Array, h: Uint8Array): Uint8Array {
  let z = new Uint8Array(16);
  let v = h.slice();
  for (let i = 0; i < 128; i++) {
    const byte = x[i >> 3];
    const bit = (byte >> (7 - (i & 7))) & 1;
    if (bit) z = xorBytes(z, v);
    const lsb = v[15] & 1;
    v = shr1(v);
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

/** GHASH_H(A || 0-pad || C || 0-pad || [len(A)]64 || [len(C)]64), per SP 800-38D §6.4. */
function ghash(h: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const pad = (buf: Uint8Array): Uint8Array => {
    const rem = buf.length % 16;
    if (rem === 0) return buf;
    const out = new Uint8Array(buf.length + (16 - rem));
    out.set(buf);
    return out;
  };
  const lenBlock = new Uint8Array(16);
  const writeBitLen64 = (out: Uint8Array, offset: number, byteLen: number): void => {
    const bits = BigInt(byteLen) * 8n;
    for (let i = 0; i < 8; i++) out[offset + 7 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  };
  writeBitLen64(lenBlock, 0, aad.length);
  writeBitLen64(lenBlock, 8, ciphertext.length);

  const full = new Uint8Array(pad(aad).length + pad(ciphertext).length + 16);
  full.set(pad(aad), 0);
  full.set(pad(ciphertext), pad(aad).length);
  full.set(lenBlock, pad(aad).length + pad(ciphertext).length);

  let y = new Uint8Array(16);
  for (let off = 0; off < full.length; off += 16) {
    y = gfMul128(xorBytes(y, full.subarray(off, off + 16)), h);
  }
  return y;
}

/** Increment the low 32 bits of a 16-byte counter block (mod 2^32), per SP 800-38D. */
function inc32(block: Uint8Array): Uint8Array {
  const out = block.slice();
  let carry = 1;
  for (let i = 15; i >= 12 && carry; i--) {
    const sum = out[i] + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out;
}

/** GCTR(key, icb, data): AES-CTR keystream XOR, incrementing the low 32 bits each block. */
function gctr(key: Uint8Array, icb: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(data.length);
  let cb = icb;
  for (let off = 0; off < data.length; off += AES_BLOCK_SIZE) {
    const ks = aesEncryptBlock(key, cb);
    const chunkLen = Math.min(AES_BLOCK_SIZE, data.length - off);
    for (let i = 0; i < chunkLen; i++) out[off + i] = data[off + i] ^ ks[i];
    cb = inc32(cb);
  }
  return out;
}

/** Form J0 for a 96-bit IV: IV || 0^31 || 1. */
function initialCounterBlock(iv: Uint8Array): Uint8Array {
  if (iv.length !== 12) throw new Error(`AES-GCM: IV must be 12 bytes (got ${iv.length})`);
  const j0 = new Uint8Array(16);
  j0.set(iv);
  j0[15] = 1;
  return j0;
}

/** Encrypt `plaintext` under AES-GCM, returning ciphertext and a 16-byte auth tag. */
export function aesGcmEncrypt(
  key: Uint8Array, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const h = aesEncryptBlock(key, new Uint8Array(16));
  const j0 = initialCounterBlock(iv);
  const ciphertext = gctr(key, inc32(j0), plaintext);
  const s = ghash(h, aad, ciphertext);
  const tag = xorBytes(s, aesEncryptBlock(key, j0)).slice(0, TAG_SIZE);
  return { ciphertext, tag };
}

/** Decrypt AES-GCM ciphertext, verifying the tag. Returns null on any tag mismatch. */
export function aesGcmDecrypt(
  key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array,
): Uint8Array | null {
  const h = aesEncryptBlock(key, new Uint8Array(16));
  const j0 = initialCounterBlock(iv);
  const s = ghash(h, aad, ciphertext);
  const expectedTag = xorBytes(s, aesEncryptBlock(key, j0)).slice(0, TAG_SIZE);
  if (expectedTag.length !== tag.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedTag.length; i++) diff |= expectedTag[i] ^ tag[i];
  if (diff !== 0) return null;
  return gctr(key, inc32(j0), ciphertext);
}

export const AES_GCM_TAG_SIZE = TAG_SIZE;
export const AES_GCM_IV_SIZE = 12;
