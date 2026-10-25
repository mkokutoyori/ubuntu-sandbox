import { SEED_S_BOXES } from './seedTables';

export const SEED_BLOCK_SIZE = 16;
export const SEED_KEY_SIZE = 16;

const [SS0, SS1, SS2, SS3] = SEED_S_BOXES;

const KEY_CONSTANTS = Uint32Array.from([
  0x9e3779b9, 0x3c6ef373, 0x78dde6e6, 0xf1bbcdcc, 0xe3779b99, 0xc6ef3733, 0x8dde6e67, 0x1bbcdccf,
  0x3779b99e, 0x6ef3733c, 0xdde6e678, 0xbbcdccf1, 0x779b99e3, 0xef3733c6, 0xde6e678d, 0xbcdccf1b,
]);

function substitute(word: number): number {
  return (SS0[word & 0xff] ^ SS1[(word >>> 8) & 0xff] ^ SS2[(word >>> 16) & 0xff] ^ SS3[word >>> 24]) >>> 0;
}

export function seedExpandKey(key: Uint8Array): Uint32Array {
  if (key.length !== SEED_KEY_SIZE) throw new Error(`SEED: key must be 16 bytes (got ${key.length})`);
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  let x1 = view.getUint32(0);
  let x2 = view.getUint32(4);
  let x3 = view.getUint32(8);
  let x4 = view.getUint32(12);
  const schedule = new Uint32Array(32);
  for (let index = 0; index < 16; index++) {
    schedule[index * 2] = substitute((x1 + x3 - KEY_CONSTANTS[index]) >>> 0);
    schedule[index * 2 + 1] = substitute((x2 + KEY_CONSTANTS[index] - x4) >>> 0);
    if (index % 2 === 0) {
      const saved = x1;
      x1 = ((x1 >>> 8) ^ (x2 << 24)) >>> 0;
      x2 = ((x2 >>> 8) ^ (saved << 24)) >>> 0;
    } else {
      const saved = x3;
      x3 = ((x3 << 8) ^ (x4 >>> 24)) >>> 0;
      x4 = ((x4 << 8) ^ (saved >>> 24)) >>> 0;
    }
  }
  return schedule;
}

function feistel(schedule: Uint32Array, state: Uint32Array, first: number, second: number, third: number, fourth: number, base: number): void {
  let t0 = (state[third] ^ schedule[base]) >>> 0;
  let t1 = (state[fourth] ^ schedule[base + 1]) >>> 0;
  t1 = (t1 ^ t0) >>> 0;
  t1 = substitute(t1);
  t0 = (t0 + t1) >>> 0;
  t0 = substitute(t0);
  t1 = (t1 + t0) >>> 0;
  t1 = substitute(t1);
  t0 = (t0 + t1) >>> 0;
  state[first] = (state[first] ^ t0) >>> 0;
  state[second] = (state[second] ^ t1) >>> 0;
}

function run(schedule: Uint32Array, block: Uint8Array, bases: readonly number[]): Uint8Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const state = Uint32Array.from([view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)]);
  bases.forEach((base, round) => {
    if (round % 2 === 0) feistel(schedule, state, 0, 1, 2, 3, base);
    else feistel(schedule, state, 2, 3, 0, 1, base);
  });
  const out = new Uint8Array(SEED_BLOCK_SIZE);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, state[2]);
  outView.setUint32(4, state[3]);
  outView.setUint32(8, state[0]);
  outView.setUint32(12, state[1]);
  return out;
}

const FORWARD = Array.from({ length: 16 }, (_, round) => round * 2);
const BACKWARD = FORWARD.slice().reverse();

export function seedEncryptBlock(schedule: Uint32Array, block: Uint8Array): Uint8Array {
  return run(schedule, block, FORWARD);
}

export function seedDecryptBlock(schedule: Uint32Array, block: Uint8Array): Uint8Array {
  return run(schedule, block, BACKWARD);
}
