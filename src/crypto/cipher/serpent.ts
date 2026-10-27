export const SERPENT_BLOCK_SIZE = 16;

const GOLDEN_RATIO = 0x9e3779b9;
const ROUNDS = 32;

const S_BOXES: readonly Uint8Array[] = [
  [3, 8, 15, 1, 10, 6, 5, 11, 14, 13, 4, 2, 7, 0, 9, 12],
  [15, 12, 2, 7, 9, 0, 5, 10, 1, 11, 14, 8, 6, 13, 3, 4],
  [8, 6, 7, 9, 3, 12, 10, 15, 13, 1, 14, 4, 0, 11, 5, 2],
  [0, 15, 11, 8, 12, 9, 6, 3, 13, 1, 2, 4, 10, 7, 5, 14],
  [1, 15, 8, 3, 12, 0, 11, 6, 2, 5, 4, 10, 9, 14, 7, 13],
  [15, 5, 2, 11, 4, 10, 9, 12, 0, 3, 14, 8, 13, 6, 7, 1],
  [7, 2, 12, 5, 8, 4, 6, 11, 14, 9, 1, 15, 13, 3, 10, 0],
  [1, 13, 15, 0, 14, 8, 2, 11, 7, 4, 12, 10, 9, 3, 5, 6],
].map((row) => Uint8Array.from(row));

const INVERSE_S_BOXES: readonly Uint8Array[] = S_BOXES.map((box) => {
  const inverse = new Uint8Array(16);
  box.forEach((value, index) => { inverse[value] = index; });
  return inverse;
});

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function substitute(box: Uint8Array, words: Uint32Array): void {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let bit = 0; bit < 32; bit++) {
    const nibble = ((words[0] >>> bit) & 1) | (((words[1] >>> bit) & 1) << 1) | (((words[2] >>> bit) & 1) << 2) | (((words[3] >>> bit) & 1) << 3);
    const mapped = box[nibble];
    a |= (mapped & 1) << bit;
    b |= ((mapped >>> 1) & 1) << bit;
    c |= ((mapped >>> 2) & 1) << bit;
    d |= ((mapped >>> 3) & 1) << bit;
  }
  words[0] = a >>> 0;
  words[1] = b >>> 0;
  words[2] = c >>> 0;
  words[3] = d >>> 0;
}

function linear(words: Uint32Array): void {
  let [x0, x1, x2, x3] = words;
  x0 = rotl(x0, 13);
  x2 = rotl(x2, 3);
  x1 = (x1 ^ x0 ^ x2) >>> 0;
  x3 = (x3 ^ x2 ^ (x0 << 3)) >>> 0;
  x1 = rotl(x1, 1);
  x3 = rotl(x3, 7);
  x0 = (x0 ^ x1 ^ x3) >>> 0;
  x2 = (x2 ^ x3 ^ (x1 << 7)) >>> 0;
  x0 = rotl(x0, 5);
  x2 = rotl(x2, 22);
  words.set([x0, x1, x2, x3]);
}

function inverseLinear(words: Uint32Array): void {
  let [x0, x1, x2, x3] = words;
  x2 = rotr(x2, 22);
  x0 = rotr(x0, 5);
  x2 = (x2 ^ x3 ^ (x1 << 7)) >>> 0;
  x0 = (x0 ^ x1 ^ x3) >>> 0;
  x3 = rotr(x3, 7);
  x1 = rotr(x1, 1);
  x3 = (x3 ^ x2 ^ (x0 << 3)) >>> 0;
  x1 = (x1 ^ x0 ^ x2) >>> 0;
  x2 = rotr(x2, 3);
  x0 = rotr(x0, 13);
  words.set([x0, x1, x2, x3]);
}

export function serpentExpandKey(key: Uint8Array): Uint32Array {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new Error(`Serpent: key must be 16, 24 or 32 bytes (got ${key.length})`);
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const prekeys = new Uint32Array(8 + 4 * (ROUNDS + 1));
  const words = key.length / 4;
  for (let index = 0; index < words; index++) prekeys[index] = view.getUint32(index * 4, true);
  if (words < 8) prekeys[words] = 1;
  for (let index = 0; index < 4 * (ROUNDS + 1); index++) {
    prekeys[index + 8] = rotl((prekeys[index] ^ prekeys[index + 3] ^ prekeys[index + 5] ^ prekeys[index + 7] ^ GOLDEN_RATIO ^ index) >>> 0, 11);
  }
  const subkeys = new Uint32Array(4 * (ROUNDS + 1));
  for (let round = 0; round <= ROUNDS; round++) {
    const slice = prekeys.slice(8 + round * 4, 12 + round * 4);
    substitute(S_BOXES[(3 - round + 8 * 4) % 8], slice);
    subkeys.set(slice, round * 4);
  }
  return subkeys;
}

function xorKey(words: Uint32Array, subkeys: Uint32Array, round: number): void {
  for (let index = 0; index < 4; index++) words[index] = (words[index] ^ subkeys[round * 4 + index]) >>> 0;
}

export function serpentEncryptBlock(subkeys: Uint32Array, block: Uint8Array): Uint8Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const words = Uint32Array.from([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)]);
  for (let round = 0; round < ROUNDS; round++) {
    xorKey(words, subkeys, round);
    substitute(S_BOXES[round % 8], words);
    if (round < ROUNDS - 1) linear(words);
  }
  xorKey(words, subkeys, ROUNDS);
  const out = new Uint8Array(SERPENT_BLOCK_SIZE);
  const outView = new DataView(out.buffer);
  words.forEach((word, index) => outView.setUint32(index * 4, word, true));
  return out;
}

export function serpentDecryptBlock(subkeys: Uint32Array, block: Uint8Array): Uint8Array {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const words = Uint32Array.from([view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)]);
  xorKey(words, subkeys, ROUNDS);
  for (let round = ROUNDS - 1; round >= 0; round--) {
    if (round < ROUNDS - 1) inverseLinear(words);
    substitute(INVERSE_S_BOXES[round % 8], words);
    xorKey(words, subkeys, round);
  }
  const out = new Uint8Array(SERPENT_BLOCK_SIZE);
  const outView = new DataView(out.buffer);
  words.forEach((word, index) => outView.setUint32(index * 4, word, true));
  return out;
}
