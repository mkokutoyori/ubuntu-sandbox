/**
 * AES-CBC with PKCS#7 padding (RFC 5652 §6.3), built on the FIPS-197 block
 * cipher. Used for reversible password encoding (Huawei `cipher`).
 */

import { aesEncryptBlock, aesDecryptBlock, AES_BLOCK_SIZE } from './aes';

/** Encrypt `data` under CBC with PKCS#7 padding. */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (iv.length !== AES_BLOCK_SIZE) throw new Error(`AES-CBC: iv must be 16 bytes (got ${iv.length})`);
  const padded = pkcs7Pad(data);
  const out = new Uint8Array(padded.length);
  let prev = iv;
  for (let off = 0; off < padded.length; off += AES_BLOCK_SIZE) {
    const block = padded.subarray(off, off + AES_BLOCK_SIZE).slice();
    for (let i = 0; i < AES_BLOCK_SIZE; i++) block[i] ^= prev[i];
    const enc = aesEncryptBlock(key, block);
    out.set(enc, off);
    prev = enc;
  }
  return out;
}

/** Decrypt CBC ciphertext and strip PKCS#7 padding. */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (iv.length !== AES_BLOCK_SIZE) throw new Error(`AES-CBC: iv must be 16 bytes (got ${iv.length})`);
  if (data.length === 0 || data.length % AES_BLOCK_SIZE !== 0) {
    throw new Error('AES-CBC: ciphertext length must be a positive multiple of 16');
  }
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += AES_BLOCK_SIZE) {
    const block = data.subarray(off, off + AES_BLOCK_SIZE);
    const dec = aesDecryptBlock(key, block);
    for (let i = 0; i < AES_BLOCK_SIZE; i++) dec[i] ^= prev[i];
    out.set(dec, off);
    prev = block;
  }
  return pkcs7Unpad(out);
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = AES_BLOCK_SIZE - (data.length % AES_BLOCK_SIZE);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > AES_BLOCK_SIZE || pad > data.length) {
    throw new Error('AES-CBC: invalid PKCS#7 padding');
  }
  return data.subarray(0, data.length - pad);
}
