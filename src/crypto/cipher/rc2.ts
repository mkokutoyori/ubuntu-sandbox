export const RC2_BLOCK_SIZE = 8;

const PI_TABLE = Uint8Array.from([
  217, 120, 249, 196, 25, 221, 181, 237, 40, 233, 253, 121, 74, 160, 216, 157,
  198, 126, 55, 131, 43, 118, 83, 142, 98, 76, 100, 136, 68, 139, 251, 162,
  23, 154, 89, 245, 135, 179, 79, 19, 97, 69, 109, 141, 9, 129, 125, 50,
  189, 143, 64, 235, 134, 183, 123, 11, 240, 149, 33, 34, 92, 107, 78, 130,
  84, 214, 101, 147, 206, 96, 178, 28, 115, 86, 192, 20, 167, 140, 241, 220,
  18, 117, 202, 31, 59, 190, 228, 209, 66, 61, 212, 48, 163, 60, 182, 38,
  111, 191, 14, 218, 70, 105, 7, 87, 39, 242, 29, 155, 188, 148, 67, 3,
  248, 17, 199, 246, 144, 239, 62, 231, 6, 195, 213, 47, 200, 102, 30, 215,
  8, 232, 234, 222, 128, 82, 238, 247, 132, 170, 114, 172, 53, 77, 106, 42,
  150, 26, 210, 113, 90, 21, 73, 116, 75, 159, 208, 94, 4, 24, 164, 236,
  194, 224, 65, 110, 15, 81, 203, 204, 36, 145, 175, 80, 161, 244, 112, 57,
  153, 124, 58, 133, 35, 184, 180, 122, 252, 2, 54, 91, 37, 85, 151, 49,
  45, 93, 250, 152, 227, 138, 146, 174, 5, 223, 41, 16, 103, 108, 186, 201,
  211, 0, 230, 207, 225, 158, 168, 44, 99, 22, 1, 63, 88, 226, 137, 169,
  13, 56, 52, 27, 171, 51, 255, 176, 187, 72, 12, 95, 185, 177, 205, 46,
  197, 243, 219, 71, 229, 165, 156, 119, 10, 166, 32, 104, 254, 127, 193, 173,
]);

const MINIMUM_KEY_BYTES = 5;
const MAXIMUM_KEY_BYTES = 128;

function rotl16(value: number, bits: number): number {
  return ((value << bits) | (value >>> (16 - bits))) & 0xffff;
}

function rotr16(value: number, bits: number): number {
  return ((value >>> bits) | (value << (16 - bits))) & 0xffff;
}

export function rc2ExpandKey(key: Uint8Array): Uint16Array {
  if (key.length < MINIMUM_KEY_BYTES || key.length > MAXIMUM_KEY_BYTES) throw new Error(`RC2: key must be 5 to 128 bytes (got ${key.length})`);
  const expanded = new Uint8Array(128);
  expanded.set(key);
  for (let index = key.length; index < 128; index++) expanded[index] = PI_TABLE[(expanded[index - key.length] + expanded[index - 1]) & 0xff];
  expanded[0] = PI_TABLE[expanded[0]];
  const bits = key.length * 8;
  const length = (bits + 7) >> 3;
  let at = 128 - length;
  let value = PI_TABLE[expanded[at] & (255 >> (7 & -bits))];
  expanded[at] = value;
  while (at-- > 0) {
    value = PI_TABLE[value ^ expanded[at + length]];
    expanded[at] = value;
  }
  return Uint16Array.from({ length: 64 }, (_, index) => expanded[index * 2] | (expanded[index * 2 + 1] << 8));
}

function readWords(block: Uint8Array): number[] {
  return [0, 1, 2, 3].map((index) => block[index * 2] | (block[index * 2 + 1] << 8));
}

function writeWords(words: readonly number[]): Uint8Array {
  const out = new Uint8Array(RC2_BLOCK_SIZE);
  words.forEach((word, index) => {
    out[index * 2] = word & 0xff;
    out[index * 2 + 1] = word >>> 8;
  });
  return out;
}

export function rc2EncryptBlock(schedule: Uint16Array, block: Uint8Array): Uint8Array {
  const [first, second, third, fourth] = readWords(block);
  let word0 = first;
  let word1 = second;
  let word2 = third;
  let word3 = fourth;
  for (let round = 0; round < 16; round++) {
    const at = round * 4;
    word0 = rotl16((word0 + (word1 & ~word3) + (word2 & word3) + schedule[at]) & 0xffff, 1);
    word1 = rotl16((word1 + (word2 & ~word0) + (word3 & word0) + schedule[at + 1]) & 0xffff, 2);
    word2 = rotl16((word2 + (word3 & ~word1) + (word0 & word1) + schedule[at + 2]) & 0xffff, 3);
    word3 = rotl16((word3 + (word0 & ~word2) + (word1 & word2) + schedule[at + 3]) & 0xffff, 5);
    if (round === 4 || round === 10) {
      word0 = (word0 + schedule[word3 & 63]) & 0xffff;
      word1 = (word1 + schedule[word0 & 63]) & 0xffff;
      word2 = (word2 + schedule[word1 & 63]) & 0xffff;
      word3 = (word3 + schedule[word2 & 63]) & 0xffff;
    }
  }
  return writeWords([word0, word1, word2, word3]);
}

export function rc2DecryptBlock(schedule: Uint16Array, block: Uint8Array): Uint8Array {
  const [first, second, third, fourth] = readWords(block);
  let word0 = first;
  let word1 = second;
  let word2 = third;
  let word3 = fourth;
  for (let round = 15; round >= 0; round--) {
    const at = round * 4;
    word3 = (rotr16(word3, 5) - ((word0 & ~word2) + (word1 & word2) + schedule[at + 3])) & 0xffff;
    word2 = (rotr16(word2, 3) - ((word3 & ~word1) + (word0 & word1) + schedule[at + 2])) & 0xffff;
    word1 = (rotr16(word1, 2) - ((word2 & ~word0) + (word3 & word0) + schedule[at + 1])) & 0xffff;
    word0 = (rotr16(word0, 1) - ((word1 & ~word3) + (word2 & word3) + schedule[at])) & 0xffff;
    if (round === 5 || round === 11) {
      word3 = (word3 - schedule[word2 & 63]) & 0xffff;
      word2 = (word2 - schedule[word1 & 63]) & 0xffff;
      word1 = (word1 - schedule[word0 & 63]) & 0xffff;
      word0 = (word0 - schedule[word3 & 63]) & 0xffff;
    }
  }
  return writeWords([word0, word1, word2, word3]);
}
