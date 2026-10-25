import { CAST5_S_BOXES } from './cast5Tables';

export const CAST5_BLOCK_SIZE = 8;
export const CAST5_KEY_SIZE = 16;

const [S1, S2, S3, S4, S5, S6, S7, S8] = CAST5_S_BOXES;

export interface Cast5Schedule {
  readonly masking: Uint32Array;
  readonly rotation: Uint8Array;
}

function rotl(value: number, bits: number): number {
  return bits === 0 ? value >>> 0 : ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function byteAt(words: Uint32Array, index: number): number {
  return (words[index >> 2] >>> (8 * (3 - (index & 3)))) & 0xff;
}

function schedule(x: Uint32Array, z: Uint32Array, k: Uint32Array): void {
  const xi = (index: number): number => byteAt(x, index);
  const zi = (index: number): number => byteAt(z, index);
  z[0] = x[0] ^ S5[xi(13)] ^ S6[xi(15)] ^ S7[xi(12)] ^ S8[xi(14)] ^ S7[xi(8)];
  z[1] = x[2] ^ S5[zi(0)] ^ S6[zi(2)] ^ S7[zi(1)] ^ S8[zi(3)] ^ S8[xi(10)];
  z[2] = x[3] ^ S5[zi(7)] ^ S6[zi(6)] ^ S7[zi(5)] ^ S8[zi(4)] ^ S5[xi(9)];
  z[3] = x[1] ^ S5[zi(10)] ^ S6[zi(9)] ^ S7[zi(11)] ^ S8[zi(8)] ^ S6[xi(11)];
  k[0] = S5[zi(8)] ^ S6[zi(9)] ^ S7[zi(7)] ^ S8[zi(6)] ^ S5[zi(2)];
  k[1] = S5[zi(10)] ^ S6[zi(11)] ^ S7[zi(5)] ^ S8[zi(4)] ^ S6[zi(6)];
  k[2] = S5[zi(12)] ^ S6[zi(13)] ^ S7[zi(3)] ^ S8[zi(2)] ^ S7[zi(9)];
  k[3] = S5[zi(14)] ^ S6[zi(15)] ^ S7[zi(1)] ^ S8[zi(0)] ^ S8[zi(12)];
  x[0] = z[2] ^ S5[zi(5)] ^ S6[zi(7)] ^ S7[zi(4)] ^ S8[zi(6)] ^ S7[zi(0)];
  x[1] = z[0] ^ S5[xi(0)] ^ S6[xi(2)] ^ S7[xi(1)] ^ S8[xi(3)] ^ S8[zi(2)];
  x[2] = z[1] ^ S5[xi(7)] ^ S6[xi(6)] ^ S7[xi(5)] ^ S8[xi(4)] ^ S5[zi(1)];
  x[3] = z[3] ^ S5[xi(10)] ^ S6[xi(9)] ^ S7[xi(11)] ^ S8[xi(8)] ^ S6[zi(3)];
  k[4] = S5[xi(3)] ^ S6[xi(2)] ^ S7[xi(12)] ^ S8[xi(13)] ^ S5[xi(8)];
  k[5] = S5[xi(1)] ^ S6[xi(0)] ^ S7[xi(14)] ^ S8[xi(15)] ^ S6[xi(13)];
  k[6] = S5[xi(7)] ^ S6[xi(6)] ^ S7[xi(8)] ^ S8[xi(9)] ^ S7[xi(3)];
  k[7] = S5[xi(5)] ^ S6[xi(4)] ^ S7[xi(10)] ^ S8[xi(11)] ^ S8[xi(7)];
  z[0] = x[0] ^ S5[xi(13)] ^ S6[xi(15)] ^ S7[xi(12)] ^ S8[xi(14)] ^ S7[xi(8)];
  z[1] = x[2] ^ S5[zi(0)] ^ S6[zi(2)] ^ S7[zi(1)] ^ S8[zi(3)] ^ S8[xi(10)];
  z[2] = x[3] ^ S5[zi(7)] ^ S6[zi(6)] ^ S7[zi(5)] ^ S8[zi(4)] ^ S5[xi(9)];
  z[3] = x[1] ^ S5[zi(10)] ^ S6[zi(9)] ^ S7[zi(11)] ^ S8[zi(8)] ^ S6[xi(11)];
  k[8] = S5[zi(3)] ^ S6[zi(2)] ^ S7[zi(12)] ^ S8[zi(13)] ^ S5[zi(9)];
  k[9] = S5[zi(1)] ^ S6[zi(0)] ^ S7[zi(14)] ^ S8[zi(15)] ^ S6[zi(12)];
  k[10] = S5[zi(7)] ^ S6[zi(6)] ^ S7[zi(8)] ^ S8[zi(9)] ^ S7[zi(2)];
  k[11] = S5[zi(5)] ^ S6[zi(4)] ^ S7[zi(10)] ^ S8[zi(11)] ^ S8[zi(6)];
  x[0] = z[2] ^ S5[zi(5)] ^ S6[zi(7)] ^ S7[zi(4)] ^ S8[zi(6)] ^ S7[zi(0)];
  x[1] = z[0] ^ S5[xi(0)] ^ S6[xi(2)] ^ S7[xi(1)] ^ S8[xi(3)] ^ S8[zi(2)];
  x[2] = z[1] ^ S5[xi(7)] ^ S6[xi(6)] ^ S7[xi(5)] ^ S8[xi(4)] ^ S5[zi(1)];
  x[3] = z[3] ^ S5[xi(10)] ^ S6[xi(9)] ^ S7[xi(11)] ^ S8[xi(8)] ^ S6[zi(3)];
  k[12] = S5[xi(8)] ^ S6[xi(9)] ^ S7[xi(7)] ^ S8[xi(6)] ^ S5[xi(3)];
  k[13] = S5[xi(10)] ^ S6[xi(11)] ^ S7[xi(5)] ^ S8[xi(4)] ^ S6[xi(7)];
  k[14] = S5[xi(12)] ^ S6[xi(13)] ^ S7[xi(3)] ^ S8[xi(2)] ^ S7[xi(8)];
  k[15] = S5[xi(14)] ^ S6[xi(15)] ^ S7[xi(1)] ^ S8[xi(0)] ^ S8[xi(13)];
}

export function cast5ExpandKey(key: Uint8Array): Cast5Schedule {
  if (key.length !== CAST5_KEY_SIZE) throw new Error(`CAST5: key must be 16 bytes (got ${key.length})`);
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const x = Uint32Array.from([view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)]);
  const z = new Uint32Array(4);
  const masking = new Uint32Array(16);
  const rotation = new Uint8Array(16);
  schedule(x, z, masking);
  const rotations = new Uint32Array(16);
  schedule(x, z, rotations);
  rotations.forEach((value, index) => { rotation[index] = value & 0x1f; });
  return { masking, rotation };
}

function roundFunction(type: number, half: number, masking: number, rotation: number): number {
  let intermediate: number;
  if (type === 0) intermediate = (masking + half) >>> 0;
  else if (type === 1) intermediate = (masking ^ half) >>> 0;
  else intermediate = (masking - half) >>> 0;
  intermediate = rotl(intermediate, rotation);
  const a = intermediate >>> 24;
  const b = (intermediate >>> 16) & 0xff;
  const c = (intermediate >>> 8) & 0xff;
  const d = intermediate & 0xff;
  if (type === 0) return ((((S1[a] ^ S2[b]) - S3[c]) >>> 0) + S4[d]) >>> 0;
  if (type === 1) return ((((S1[a] - S2[b]) >>> 0) + S3[c]) ^ S4[d]) >>> 0;
  return ((((S1[a] + S2[b]) >>> 0) ^ S3[c]) - S4[d]) >>> 0;
}

function run(schedule_: Cast5Schedule, block: Uint8Array, order: readonly number[]): Uint8Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  let left = view.getUint32(0);
  let right = view.getUint32(4);
  for (const round of order) {
    const previous = left;
    left = right;
    right = (previous ^ roundFunction(round % 3, right, schedule_.masking[round], schedule_.rotation[round])) >>> 0;
  }
  const out = new Uint8Array(CAST5_BLOCK_SIZE);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, right);
  outView.setUint32(4, left);
  return out;
}

const FORWARD = Array.from({ length: 16 }, (_, index) => index);
const BACKWARD = FORWARD.slice().reverse();

export function cast5EncryptBlock(schedule_: Cast5Schedule, block: Uint8Array): Uint8Array {
  return run(schedule_, block, FORWARD);
}

export function cast5DecryptBlock(schedule_: Cast5Schedule, block: Uint8Array): Uint8Array {
  return run(schedule_, block, BACKWARD);
}
