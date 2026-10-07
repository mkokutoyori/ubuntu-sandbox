export const CAMELLIA_BLOCK_SIZE = 16;

const SBOX1 = Uint8Array.from([
  0x70, 0x82, 0x2c, 0xec, 0xb3, 0x27, 0xc0, 0xe5, 0xe4, 0x85, 0x57, 0x35, 0xea, 0x0c, 0xae, 0x41,
  0x23, 0xef, 0x6b, 0x93, 0x45, 0x19, 0xa5, 0x21, 0xed, 0x0e, 0x4f, 0x4e, 0x1d, 0x65, 0x92, 0xbd,
  0x86, 0xb8, 0xaf, 0x8f, 0x7c, 0xeb, 0x1f, 0xce, 0x3e, 0x30, 0xdc, 0x5f, 0x5e, 0xc5, 0x0b, 0x1a,
  0xa6, 0xe1, 0x39, 0xca, 0xd5, 0x47, 0x5d, 0x3d, 0xd9, 0x01, 0x5a, 0xd6, 0x51, 0x56, 0x6c, 0x4d,
  0x8b, 0x0d, 0x9a, 0x66, 0xfb, 0xcc, 0xb0, 0x2d, 0x74, 0x12, 0x2b, 0x20, 0xf0, 0xb1, 0x84, 0x99,
  0xdf, 0x4c, 0xcb, 0xc2, 0x34, 0x7e, 0x76, 0x05, 0x6d, 0xb7, 0xa9, 0x31, 0xd1, 0x17, 0x04, 0xd7,
  0x14, 0x58, 0x3a, 0x61, 0xde, 0x1b, 0x11, 0x1c, 0x32, 0x0f, 0x9c, 0x16, 0x53, 0x18, 0xf2, 0x22,
  0xfe, 0x44, 0xcf, 0xb2, 0xc3, 0xb5, 0x7a, 0x91, 0x24, 0x08, 0xe8, 0xa8, 0x60, 0xfc, 0x69, 0x50,
  0xaa, 0xd0, 0xa0, 0x7d, 0xa1, 0x89, 0x62, 0x97, 0x54, 0x5b, 0x1e, 0x95, 0xe0, 0xff, 0x64, 0xd2,
  0x10, 0xc4, 0x00, 0x48, 0xa3, 0xf7, 0x75, 0xdb, 0x8a, 0x03, 0xe6, 0xda, 0x09, 0x3f, 0xdd, 0x94,
  0x87, 0x5c, 0x83, 0x02, 0xcd, 0x4a, 0x90, 0x33, 0x73, 0x67, 0xf6, 0xf3, 0x9d, 0x7f, 0xbf, 0xe2,
  0x52, 0x9b, 0xd8, 0x26, 0xc8, 0x37, 0xc6, 0x3b, 0x81, 0x96, 0x6f, 0x4b, 0x13, 0xbe, 0x63, 0x2e,
  0xe9, 0x79, 0xa7, 0x8c, 0x9f, 0x6e, 0xbc, 0x8e, 0x29, 0xf5, 0xf9, 0xb6, 0x2f, 0xfd, 0xb4, 0x59,
  0x78, 0x98, 0x06, 0x6a, 0xe7, 0x46, 0x71, 0xba, 0xd4, 0x25, 0xab, 0x42, 0x88, 0xa2, 0x8d, 0xfa,
  0x72, 0x07, 0xb9, 0x55, 0xf8, 0xee, 0xac, 0x0a, 0x36, 0x49, 0x2a, 0x68, 0x3c, 0x38, 0xf1, 0xa4,
  0x40, 0x28, 0xd3, 0x7b, 0xbb, 0xc9, 0x43, 0xc1, 0x15, 0xe3, 0xad, 0xf4, 0x77, 0xc7, 0x80, 0x9e,
]);

const SBOX2 = SBOX1.map((v) => ((v << 1) | (v >>> 7)) & 0xff);
const SBOX3 = SBOX1.map((v) => ((v << 7) | (v >>> 1)) & 0xff);
const SBOX4 = Uint8Array.from({ length: 256 }, (_, i) => SBOX1[((i << 1) | (i >>> 7)) & 0xff]);

const SIGMA: readonly (readonly [number, number])[] = [
  [0xa09e667f, 0x3bcc908b], [0xb67ae858, 0x4caa73b2], [0xc6ef372f, 0xe94f82be],
  [0x54ff53a5, 0xf1d36f1c], [0x10e527fa, 0xde682d1d], [0xb05688c2, 0xb3e6c1fd],
];

type Word128 = readonly [number, number, number, number];
type Word64 = readonly [number, number];

function feistel(input: Word64, key: Word64): Word64 {
  const hi = (input[0] ^ key[0]) >>> 0;
  const lo = (input[1] ^ key[1]) >>> 0;
  const t1 = SBOX1[hi >>> 24];
  const t2 = SBOX2[(hi >>> 16) & 0xff];
  const t3 = SBOX3[(hi >>> 8) & 0xff];
  const t4 = SBOX4[hi & 0xff];
  const t5 = SBOX2[lo >>> 24];
  const t6 = SBOX3[(lo >>> 16) & 0xff];
  const t7 = SBOX4[(lo >>> 8) & 0xff];
  const t8 = SBOX1[lo & 0xff];
  const y1 = t1 ^ t3 ^ t4 ^ t6 ^ t7 ^ t8;
  const y2 = t1 ^ t2 ^ t4 ^ t5 ^ t7 ^ t8;
  const y3 = t1 ^ t2 ^ t3 ^ t5 ^ t6 ^ t8;
  const y4 = t2 ^ t3 ^ t4 ^ t5 ^ t6 ^ t7;
  const y5 = t1 ^ t2 ^ t6 ^ t7 ^ t8;
  const y6 = t2 ^ t3 ^ t5 ^ t7 ^ t8;
  const y7 = t3 ^ t4 ^ t5 ^ t6 ^ t8;
  const y8 = t1 ^ t4 ^ t5 ^ t6 ^ t7;
  return [((y1 << 24) | (y2 << 16) | (y3 << 8) | y4) >>> 0, ((y5 << 24) | (y6 << 16) | (y7 << 8) | y8) >>> 0];
}

function rotl128(value: Word128, bits: number): Word128 {
  const shift = bits % 128;
  const words = shift >= 32 ? [...value.slice(Math.floor(shift / 32)), ...value.slice(0, Math.floor(shift / 32))] : [...value];
  const rest = shift % 32;
  if (rest === 0) return [words[0] >>> 0, words[1] >>> 0, words[2] >>> 0, words[3] >>> 0];
  return [
    ((words[0] << rest) | (words[1] >>> (32 - rest))) >>> 0,
    ((words[1] << rest) | (words[2] >>> (32 - rest))) >>> 0,
    ((words[2] << rest) | (words[3] >>> (32 - rest))) >>> 0,
    ((words[3] << rest) | (words[0] >>> (32 - rest))) >>> 0,
  ];
}

function xor128(a: Word128, b: Word128): Word128 {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0, (a[2] ^ b[2]) >>> 0, (a[3] ^ b[3]) >>> 0];
}

function high(value: Word128): Word64 { return [value[0], value[1]]; }
function low(value: Word128): Word64 { return [value[2], value[3]]; }

function readWords(bytes: Uint8Array, offset: number): Word128 {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  return [view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)];
}

function writeWords(words: Word128): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, words[i] >>> 0);
  return out;
}

interface Schedule {
  readonly kw: readonly Word64[];
  readonly k: readonly Word64[];
  readonly ke: readonly Word64[];
}

const scheduleCache = new Map<string, Schedule>();

function schedule(key: Uint8Array): Schedule {
  const cacheKey = Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
  const cached = scheduleCache.get(cacheKey);
  if (cached) return cached;
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new Error(`Camellia: key must be 16, 24 or 32 bytes (got ${key.length})`);
  let kl: Word128;
  let kr: Word128;
  if (key.length === 16) { kl = readWords(key, 0); kr = [0, 0, 0, 0]; }
  else if (key.length === 24) {
    kl = readWords(key, 0);
    const tail = new DataView(key.buffer, key.byteOffset + 16, 8);
    const a = tail.getUint32(0);
    const b = tail.getUint32(4);
    kr = [a, b, (~a) >>> 0, (~b) >>> 0];
  } else { kl = readWords(key, 0); kr = readWords(key, 16); }

  const mix = (state: Word128, sigmaA: number, sigmaB: number): Word128 => {
    let d1: Word64 = high(state);
    let d2: Word64 = low(state);
    const f1 = feistel(d1, SIGMA[sigmaA]);
    d2 = [(d2[0] ^ f1[0]) >>> 0, (d2[1] ^ f1[1]) >>> 0];
    const f2 = feistel(d2, SIGMA[sigmaB]);
    d1 = [(d1[0] ^ f2[0]) >>> 0, (d1[1] ^ f2[1]) >>> 0];
    return [d1[0], d1[1], d2[0], d2[1]];
  };
  const first = xor128(kl, kr);
  let ka = mix(first, 0, 1);
  ka = xor128(ka, kl);
  ka = mix(ka, 2, 3);
  const kb = key.length === 16 ? ([0, 0, 0, 0] as Word128) : mix(xor128(ka, kr), 4, 5);

  const pairs = (value: Word128, bits: number): readonly [Word64, Word64] => {
    const rotated = rotl128(value, bits);
    return [high(rotated), low(rotated)];
  };
  let result: Schedule;
  if (key.length === 16) {
    const [kw1, kw2] = pairs(kl, 0);
    const [k1, k2] = pairs(ka, 0);
    const [k3, k4] = pairs(kl, 15);
    const [k5, k6] = pairs(ka, 15);
    const [ke1, ke2] = pairs(ka, 30);
    const [k7, k8] = pairs(kl, 45);
    const [k9] = pairs(ka, 45);
    const [, k10] = pairs(kl, 60);
    const [k11, k12] = pairs(ka, 60);
    const [ke3, ke4] = pairs(kl, 77);
    const [k13, k14] = pairs(kl, 94);
    const [k15, k16] = pairs(ka, 94);
    const [k17, k18] = pairs(kl, 111);
    const [kw3, kw4] = pairs(ka, 111);
    result = { kw: [kw1, kw2, kw3, kw4], k: [k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16, k17, k18], ke: [ke1, ke2, ke3, ke4] };
  } else {
    const [kw1, kw2] = pairs(kl, 0);
    const [k1, k2] = pairs(kb, 0);
    const [k3, k4] = pairs(kr, 15);
    const [k5, k6] = pairs(ka, 15);
    const [ke1, ke2] = pairs(kr, 30);
    const [k7, k8] = pairs(kb, 30);
    const [k9, k10] = pairs(kl, 45);
    const [k11, k12] = pairs(ka, 45);
    const [ke3, ke4] = pairs(kl, 60);
    const [k13, k14] = pairs(kr, 60);
    const [k15, k16] = pairs(kb, 60);
    const [k17, k18] = pairs(kl, 77);
    const [ke5, ke6] = pairs(ka, 77);
    const [k19, k20] = pairs(kr, 94);
    const [k21, k22] = pairs(ka, 94);
    const [k23, k24] = pairs(kl, 111);
    const [kw3, kw4] = pairs(kb, 111);
    result = {
      kw: [kw1, kw2, kw3, kw4],
      k: [k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16, k17, k18, k19, k20, k21, k22, k23, k24],
      ke: [ke1, ke2, ke3, ke4, ke5, ke6],
    };
  }
  scheduleCache.set(cacheKey, result);
  return result;
}

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function fl(input: Word64, key: Word64): Word64 {
  let x1 = input[0];
  let x2 = input[1];
  x2 = (x2 ^ rotl32((x1 & key[0]) >>> 0, 1)) >>> 0;
  x1 = (x1 ^ (x2 | key[1])) >>> 0;
  return [x1, x2];
}

function flInverse(input: Word64, key: Word64): Word64 {
  let y1 = input[0];
  let y2 = input[1];
  y1 = (y1 ^ (y2 | key[1])) >>> 0;
  y2 = (y2 ^ rotl32((y1 & key[0]) >>> 0, 1)) >>> 0;
  return [y1, y2];
}

function crypt(block: Uint8Array, keys: Schedule, decrypting: boolean): Uint8Array {
  if (block.length !== CAMELLIA_BLOCK_SIZE) throw new Error('Camellia: block must be 16 bytes');
  const rounds = keys.k.length;
  const kw = decrypting ? [keys.kw[2], keys.kw[3], keys.kw[0], keys.kw[1]] : keys.kw;
  const subkeys = decrypting ? [...keys.k].reverse() : keys.k;
  const flKeys = decrypting ? [...keys.ke].reverse() : keys.ke;
  const input = readWords(block, 0);
  let d1: Word64 = [(input[0] ^ kw[0][0]) >>> 0, (input[1] ^ kw[0][1]) >>> 0];
  let d2: Word64 = [(input[2] ^ kw[1][0]) >>> 0, (input[3] ^ kw[1][1]) >>> 0];
  for (let round = 0; round < rounds; round += 2) {
    if (round > 0 && round % 6 === 0) {
      const index = (round / 6 - 1) * 2;
      d1 = fl(d1, flKeys[index]);
      d2 = flInverse(d2, flKeys[index + 1]);
    }
    const f1 = feistel(d1, subkeys[round]);
    d2 = [(d2[0] ^ f1[0]) >>> 0, (d2[1] ^ f1[1]) >>> 0];
    const f2 = feistel(d2, subkeys[round + 1]);
    d1 = [(d1[0] ^ f2[0]) >>> 0, (d1[1] ^ f2[1]) >>> 0];
  }
  d2 = [(d2[0] ^ kw[2][0]) >>> 0, (d2[1] ^ kw[2][1]) >>> 0];
  d1 = [(d1[0] ^ kw[3][0]) >>> 0, (d1[1] ^ kw[3][1]) >>> 0];
  return writeWords([d2[0], d2[1], d1[0], d1[1]]);
}

export function camelliaEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return crypt(block, schedule(key), false);
}

export function camelliaDecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return crypt(block, schedule(key), true);
}
