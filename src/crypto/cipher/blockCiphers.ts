import { createAesDecryptor, createAesEncryptor, AES_BLOCK_SIZE } from './aes';
import { ariaDecryptBlock, ariaEncryptBlock, ARIA_BLOCK_SIZE } from './aria';
import { Blowfish } from './blowfish';
import type { BlockPrimitive } from './blockModes';
import { camelliaDecryptBlock, camelliaEncryptBlock, CAMELLIA_BLOCK_SIZE } from './camellia';
import {
  desDecryptBlock, desEncryptBlock, DES_BLOCK_SIZE, isDesWeakKey, tripleDesDecryptBlock, tripleDesEncryptBlock,
} from './des';
import { cast5DecryptBlock, cast5EncryptBlock, cast5ExpandKey, CAST5_BLOCK_SIZE } from './cast5';
import { rc2DecryptBlock, rc2EncryptBlock, rc2ExpandKey, RC2_BLOCK_SIZE } from './rc2';
import { seedDecryptBlock, seedEncryptBlock, seedExpandKey, SEED_BLOCK_SIZE } from './seed';
import { serpentDecryptBlock, serpentEncryptBlock, serpentExpandKey, SERPENT_BLOCK_SIZE } from './serpent';
import { sm4DecryptBlock, sm4EncryptBlock, SM4_BLOCK_SIZE } from './sm4';
import { twofishDecryptBlock, twofishEncryptBlock, twofishExpandKey, TWOFISH_BLOCK_SIZE } from './twofish';

export interface BlockCipherFamily {
  readonly blockSize: number;
  readonly isWeakKey?: (key: Uint8Array) => boolean;
  create(key: Uint8Array): BlockPrimitive;
}

const BLOWFISH_BLOCK_SIZE = 8;

function words(block: Uint8Array): Uint32Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return Uint32Array.from([view.getUint32(0, false), view.getUint32(4, false)]);
}

function bytes(pair: Uint32Array): Uint8Array {
  const out = new Uint8Array(BLOWFISH_BLOCK_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, pair[0], false);
  view.setUint32(4, pair[1], false);
  return out;
}

function keyed(blockSize: number, encrypt: (key: Uint8Array, block: Uint8Array) => Uint8Array, decrypt: (key: Uint8Array, block: Uint8Array) => Uint8Array) {
  return (key: Uint8Array): BlockPrimitive => {
    const own = Uint8Array.from(key);
    return { blockSize, encrypt: (block) => encrypt(own, block), decrypt: (block) => decrypt(own, block) };
  };
}

export const AES_FAMILY: BlockCipherFamily = {
  blockSize: AES_BLOCK_SIZE,
  create: (key) => ({ blockSize: AES_BLOCK_SIZE, encrypt: createAesEncryptor(key), decrypt: createAesDecryptor(key) }),
};

export const DES_FAMILY: BlockCipherFamily = {
  blockSize: DES_BLOCK_SIZE,
  isWeakKey: isDesWeakKey,
  create: keyed(DES_BLOCK_SIZE, desEncryptBlock, desDecryptBlock),
};

export const TRIPLE_DES_FAMILY: BlockCipherFamily = {
  blockSize: DES_BLOCK_SIZE,
  isWeakKey: (key) => [key.subarray(0, 8), key.subarray(8, 16), key.subarray(key.length === 24 ? 16 : 0, key.length === 24 ? 24 : 8)].some(isDesWeakKey),
  create: keyed(DES_BLOCK_SIZE, tripleDesEncryptBlock, tripleDesDecryptBlock),
};

export const BLOWFISH_FAMILY: BlockCipherFamily = {
  blockSize: BLOWFISH_BLOCK_SIZE,
  create: (key) => {
    const state = Blowfish.withKey(key);
    return {
      blockSize: BLOWFISH_BLOCK_SIZE,
      encrypt: (block) => {
        const pair = words(block);
        state.encipher(pair);
        return bytes(pair);
      },
      decrypt: (block) => {
        const pair = words(block);
        state.decipher(pair);
        return bytes(pair);
      },
    };
  },
};

export const CAMELLIA_FAMILY: BlockCipherFamily = {
  blockSize: CAMELLIA_BLOCK_SIZE,
  create: keyed(CAMELLIA_BLOCK_SIZE, camelliaEncryptBlock, camelliaDecryptBlock),
};

export const ARIA_FAMILY: BlockCipherFamily = {
  blockSize: ARIA_BLOCK_SIZE,
  create: keyed(ARIA_BLOCK_SIZE, ariaEncryptBlock, ariaDecryptBlock),
};

export const SM4_FAMILY: BlockCipherFamily = {
  blockSize: SM4_BLOCK_SIZE,
  create: keyed(SM4_BLOCK_SIZE, sm4EncryptBlock, sm4DecryptBlock),
};

function scheduled<Schedule>(
  blockSize: number,
  expand: (key: Uint8Array) => Schedule,
  encrypt: (schedule: Schedule, block: Uint8Array) => Uint8Array,
  decrypt: (schedule: Schedule, block: Uint8Array) => Uint8Array,
): (key: Uint8Array) => BlockPrimitive {
  return (key) => {
    const schedule = expand(key);
    return { blockSize, encrypt: (block) => encrypt(schedule, block), decrypt: (block) => decrypt(schedule, block) };
  };
}

export const CAST5_FAMILY: BlockCipherFamily = {
  blockSize: CAST5_BLOCK_SIZE,
  create: scheduled(CAST5_BLOCK_SIZE, cast5ExpandKey, cast5EncryptBlock, cast5DecryptBlock),
};

export const TWOFISH_FAMILY: BlockCipherFamily = {
  blockSize: TWOFISH_BLOCK_SIZE,
  create: scheduled(TWOFISH_BLOCK_SIZE, twofishExpandKey, twofishEncryptBlock, twofishDecryptBlock),
};

export const SERPENT_FAMILY: BlockCipherFamily = {
  blockSize: SERPENT_BLOCK_SIZE,
  create: scheduled(SERPENT_BLOCK_SIZE, serpentExpandKey, serpentEncryptBlock, serpentDecryptBlock),
};

export const RC2_FAMILY: BlockCipherFamily = {
  blockSize: RC2_BLOCK_SIZE,
  create: scheduled(RC2_BLOCK_SIZE, rc2ExpandKey, rc2EncryptBlock, rc2DecryptBlock),
};

export const SEED_FAMILY: BlockCipherFamily = {
  blockSize: SEED_BLOCK_SIZE,
  create: scheduled(SEED_BLOCK_SIZE, seedExpandKey, seedEncryptBlock, seedDecryptBlock),
};
