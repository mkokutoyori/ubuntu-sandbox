import { aesDecryptBlock, aesEncryptBlock, AES_BLOCK_SIZE } from './aes';

function xorInto(target: Uint8Array, other: Uint8Array): Uint8Array {
  for (let index = 0; index < target.length; index++) target[index] ^= other[index];
  return target;
}

function requireIv(iv: Uint8Array): void {
  if (iv.length !== AES_BLOCK_SIZE) throw new Error(`AES-CTS: iv must be 16 bytes (got ${iv.length})`);
}

export function aesCtsEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  requireIv(iv);
  if (data.length < AES_BLOCK_SIZE) throw new Error('AES-CTS: input must hold at least one block');
  const blockCount = Math.ceil(data.length / AES_BLOCK_SIZE);
  const tail = data.length - (blockCount - 1) * AES_BLOCK_SIZE;
  const blocks: Uint8Array[] = [];
  let previous = iv;
  for (let index = 0; index < blockCount; index++) {
    const block = new Uint8Array(AES_BLOCK_SIZE);
    block.set(data.subarray(index * AES_BLOCK_SIZE, (index + 1) * AES_BLOCK_SIZE));
    previous = aesEncryptBlock(key, xorInto(block, previous));
    blocks.push(previous);
  }
  if (blockCount === 1) return blocks[0];
  const out = new Uint8Array(data.length);
  for (let index = 0; index < blockCount - 2; index++) out.set(blocks[index], index * AES_BLOCK_SIZE);
  out.set(blocks[blockCount - 1], (blockCount - 2) * AES_BLOCK_SIZE);
  out.set(blocks[blockCount - 2].subarray(0, tail), (blockCount - 1) * AES_BLOCK_SIZE);
  return out;
}

export function aesCtsDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  requireIv(iv);
  if (data.length < AES_BLOCK_SIZE) throw new Error('AES-CTS: input must hold at least one block');
  const blockCount = Math.ceil(data.length / AES_BLOCK_SIZE);
  const tail = data.length - (blockCount - 1) * AES_BLOCK_SIZE;
  const out = new Uint8Array(data.length);
  if (blockCount === 1) return xorInto(aesDecryptBlock(key, data), iv);

  let previous = iv;
  for (let index = 0; index < blockCount - 2; index++) {
    const block = data.subarray(index * AES_BLOCK_SIZE, (index + 1) * AES_BLOCK_SIZE);
    out.set(xorInto(aesDecryptBlock(key, block), previous), index * AES_BLOCK_SIZE);
    previous = block;
  }
  const lastFull = data.subarray((blockCount - 2) * AES_BLOCK_SIZE, (blockCount - 1) * AES_BLOCK_SIZE);
  const truncated = data.subarray((blockCount - 1) * AES_BLOCK_SIZE);
  const intermediate = aesDecryptBlock(key, lastFull);
  const penultimateCipher = new Uint8Array(AES_BLOCK_SIZE);
  penultimateCipher.set(truncated);
  penultimateCipher.set(intermediate.subarray(tail), tail);
  out.set(xorInto(aesDecryptBlock(key, penultimateCipher), previous), (blockCount - 2) * AES_BLOCK_SIZE);
  const finalPlain = new Uint8Array(tail);
  for (let index = 0; index < tail; index++) finalPlain[index] = intermediate[index] ^ truncated[index];
  out.set(finalPlain, (blockCount - 1) * AES_BLOCK_SIZE);
  return out;
}
