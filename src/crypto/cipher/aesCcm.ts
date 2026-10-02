import { aesEncryptBlock, AES_BLOCK_SIZE } from './aes';

export const AES_CCM_NONCE_SIZE = 12;
const LENGTH_FIELD = 3;

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

function counterBlock(nonce: Uint8Array, counter: number): Uint8Array {
  const block = new Uint8Array(AES_BLOCK_SIZE);
  block[0] = LENGTH_FIELD - 1;
  block.set(nonce, 1);
  block[13] = (counter >> 16) & 0xff;
  block[14] = (counter >> 8) & 0xff;
  block[15] = counter & 0xff;
  return block;
}

function cbcMac(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, message: Uint8Array, tagLength: number): Uint8Array {
  const b0 = new Uint8Array(AES_BLOCK_SIZE);
  b0[0] = (aad.length > 0 ? 0x40 : 0) | (((tagLength - 2) / 2) << 3) | (LENGTH_FIELD - 1);
  b0.set(nonce, 1);
  b0[13] = (message.length >> 16) & 0xff;
  b0[14] = (message.length >> 8) & 0xff;
  b0[15] = message.length & 0xff;
  let state = aesEncryptBlock(key, b0);

  if (aad.length > 0) {
    if (aad.length >= 0xff00) throw new RangeError('CCM: additional data too long');
    const encoded = new Uint8Array(2 + aad.length);
    encoded[0] = (aad.length >> 8) & 0xff;
    encoded[1] = aad.length & 0xff;
    encoded.set(aad, 2);
    for (let offset = 0; offset < encoded.length; offset += AES_BLOCK_SIZE) {
      const block = new Uint8Array(AES_BLOCK_SIZE);
      block.set(encoded.subarray(offset, Math.min(offset + AES_BLOCK_SIZE, encoded.length)));
      xorInto(block, state);
      state = aesEncryptBlock(key, block);
    }
  }
  for (let offset = 0; offset < message.length; offset += AES_BLOCK_SIZE) {
    const block = new Uint8Array(AES_BLOCK_SIZE);
    block.set(message.subarray(offset, Math.min(offset + AES_BLOCK_SIZE, message.length)));
    xorInto(block, state);
    state = aesEncryptBlock(key, block);
  }
  return state.slice(0, tagLength);
}

function ctr(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += AES_BLOCK_SIZE) {
    const stream = aesEncryptBlock(key, counterBlock(nonce, 1 + offset / AES_BLOCK_SIZE));
    const take = Math.min(AES_BLOCK_SIZE, data.length - offset);
    for (let i = 0; i < take; i++) out[offset + i] = data[offset + i] ^ stream[i];
  }
  return out;
}

export function aesCcmEncrypt(
  key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, tagLength: number,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  if (nonce.length !== AES_CCM_NONCE_SIZE) throw new RangeError('CCM: nonce must be 12 bytes');
  const mac = cbcMac(key, nonce, aad, plaintext, tagLength);
  const s0 = aesEncryptBlock(key, counterBlock(nonce, 0));
  const tag = mac.map((byte, index) => byte ^ s0[index]);
  return { ciphertext: ctr(key, nonce, plaintext), tag };
}

export function aesCcmDecrypt(
  key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array,
): Uint8Array | null {
  if (nonce.length !== AES_CCM_NONCE_SIZE) return null;
  const plaintext = ctr(key, nonce, ciphertext);
  const mac = cbcMac(key, nonce, aad, plaintext, tag.length);
  const s0 = aesEncryptBlock(key, counterBlock(nonce, 0));
  let diff = 0;
  for (let i = 0; i < tag.length; i++) diff |= (mac[i] ^ s0[i]) ^ tag[i];
  return diff === 0 ? plaintext : null;
}
