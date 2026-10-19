import { aesEncryptBlock, AES_BLOCK_SIZE } from '../cipher/aes';

const RB = 0x87;

export function doubleBlock(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(AES_BLOCK_SIZE);
  for (let i = 0; i < AES_BLOCK_SIZE; i++) {
    out[i] = ((block[i] << 1) & 0xff) | (i + 1 < AES_BLOCK_SIZE ? block[i + 1] >> 7 : 0);
  }
  if (block[0] & 0x80) out[AES_BLOCK_SIZE - 1] ^= RB;
  return out;
}

export function aesCmac(key: Uint8Array, message: Uint8Array): Uint8Array {
  const zero = new Uint8Array(AES_BLOCK_SIZE);
  const k1 = doubleBlock(aesEncryptBlock(key, zero));
  const k2 = doubleBlock(k1);
  const blocks = Math.max(1, Math.ceil(message.length / AES_BLOCK_SIZE));
  const complete = message.length > 0 && message.length % AES_BLOCK_SIZE === 0;
  const last = new Uint8Array(AES_BLOCK_SIZE);
  const start = (blocks - 1) * AES_BLOCK_SIZE;
  if (complete) {
    for (let i = 0; i < AES_BLOCK_SIZE; i++) last[i] = message[start + i] ^ k1[i];
  } else {
    const remainder = message.subarray(start);
    last.set(remainder);
    last[remainder.length] = 0x80;
    for (let i = 0; i < AES_BLOCK_SIZE; i++) last[i] ^= k2[i];
  }
  let state = new Uint8Array(AES_BLOCK_SIZE);
  for (let b = 0; b < blocks - 1; b++) {
    const block = new Uint8Array(AES_BLOCK_SIZE);
    for (let i = 0; i < AES_BLOCK_SIZE; i++) block[i] = state[i] ^ message[b * AES_BLOCK_SIZE + i];
    state = aesEncryptBlock(key, block);
  }
  for (let i = 0; i < AES_BLOCK_SIZE; i++) last[i] ^= state[i];
  return aesEncryptBlock(key, last);
}
