import type { HashAlgorithm } from './HashAlgorithm';

const MASK = (1n << 64n) - 1n;
const LANES = 25;
const ROUNDS = 24;
const SHA3_DOMAIN_SUFFIX = 0x06;
const PAD_END = 0x80;

function lfsrBit(t: number): number {
  let register = 1;
  for (let i = 1; i <= t % 255; i++) {
    register <<= 1;
    if ((register & 0x100) !== 0) register ^= 0x171;
  }
  return register & 1;
}

function roundConstant(round: number): bigint {
  let constant = 0n;
  for (let j = 0; j <= 6; j++) {
    if (lfsrBit(j + 7 * round) === 1) constant |= 1n << BigInt((1 << j) - 1);
  }
  return constant;
}

const ROUND_CONSTANTS: readonly bigint[] = Array.from({ length: ROUNDS }, (_, round) => roundConstant(round));

const ROTATIONS: readonly number[] = (() => {
  const offsets = new Array<number>(LANES).fill(0);
  let x = 1;
  let y = 0;
  for (let t = 0; t < ROUNDS; t++) {
    offsets[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  return offsets;
})();

function rotateLeft(value: bigint, count: number): bigint {
  if (count === 0) return value;
  const shift = BigInt(count);
  return ((value << shift) | (value >> (64n - shift))) & MASK;
}

function permute(state: bigint[]): void {
  for (let round = 0; round < ROUNDS; round++) {
    const columns = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const mix = columns[(x + 4) % 5] ^ rotateLeft(columns[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= mix;
    }
    const moved = new Array<bigint>(LANES);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft(state[x + 5 * y], ROTATIONS[x + 5 * y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) state[x + 5 * y] = moved[x + 5 * y] ^ (~moved[((x + 1) % 5) + 5 * y] & MASK & moved[((x + 2) % 5) + 5 * y]);
    }
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

function absorbBlock(state: bigint[], block: Uint8Array, rate: number): void {
  for (let lane = 0; lane < rate / 8; lane++) {
    let word = 0n;
    for (let byte = 7; byte >= 0; byte--) word = (word << 8n) | BigInt(block[lane * 8 + byte]);
    state[lane] ^= word;
  }
  permute(state);
}

export type Sha3Bits = 224 | 256 | 384 | 512;

export function sha3(bits: Sha3Bits, input: Uint8Array): Uint8Array {
  const rate = 200 - 2 * (bits / 8);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] ^= SHA3_DOMAIN_SUFFIX;
  padded[padded.length - 1] ^= PAD_END;
  const state = new Array<bigint>(LANES).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) absorbBlock(state, padded.subarray(offset, offset + rate), rate);
  const out = new Uint8Array(bits / 8);
  for (let index = 0; index < out.length; index++) out[index] = Number((state[Math.floor(index / 8)] >> BigInt(8 * (index % 8))) & 0xffn);
  return out;
}

export function sha3Algorithm(bits: Sha3Bits): HashAlgorithm {
  return { blockSize: 200 - 2 * (bits / 8), digestSize: bits / 8, digest: (input) => sha3(bits, input) };
}

export const SHA3_224: HashAlgorithm = sha3Algorithm(224);
export const SHA3_256: HashAlgorithm = sha3Algorithm(256);
export const SHA3_384: HashAlgorithm = sha3Algorithm(384);
export const SHA3_512: HashAlgorithm = sha3Algorithm(512);
