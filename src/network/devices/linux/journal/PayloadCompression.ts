const MIN_MATCH = 4;
const MAX_MATCH = 258;
const WINDOW = 1 << 17;
const CHAIN_LIMIT = 32;
const HASH_BITS = 15;
const STAND_IN_FRAME_BYTES = 18;
const STAND_IN_SCALE = 1.08;
const TABLE_BITS_PER_SYMBOL = 5;
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];

interface Token {
  readonly literal: number;
  readonly length: number;
  readonly distance: number;
}

function lengthSymbol(length: number): number {
  let symbol = 0;
  while (symbol + 1 < LENGTH_BASE.length && LENGTH_BASE[symbol + 1] <= length) symbol++;
  return symbol;
}

function distanceSymbol(distance: number): { symbol: number; extra: number } {
  const bits = 31 - Math.clz32(distance - 1 || 1);
  return { symbol: distance <= 2 ? distance - 1 : bits * 2 + (((distance - 1) >> (bits - 1)) & 1), extra: Math.max(0, bits - 1) };
}

function hashAt(data: Uint8Array, at: number): number {
  const value = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24);
  return Math.imul(value, 0x9e3779b1) >>> (32 - HASH_BITS);
}

function tokenize(data: Uint8Array): Token[] {
  const tokens: Token[] = [];
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const previous = new Int32Array(data.length).fill(-1);
  let at = 0;
  const insert = (position: number): void => {
    if (position + MIN_MATCH > data.length) return;
    const hash = hashAt(data, position);
    previous[position] = head[hash];
    head[hash] = position;
  };
  while (at < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (at + MIN_MATCH <= data.length) {
      let candidate = head[hashAt(data, at)];
      let steps = 0;
      while (candidate >= 0 && at - candidate <= WINDOW && steps++ < CHAIN_LIMIT) {
        let length = 0;
        while (length < MAX_MATCH && at + length < data.length && data[candidate + length] === data[at + length]) length++;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = at - candidate;
        }
        candidate = previous[candidate];
      }
    }
    if (bestLength >= MIN_MATCH) {
      tokens.push({ literal: -1, length: bestLength, distance: bestDistance });
      for (let k = 0; k < bestLength; k++) insert(at + k);
      at += bestLength;
    } else {
      tokens.push({ literal: data[at], length: 0, distance: 0 });
      insert(at);
      at++;
    }
  }
  return tokens;
}

function entropyBits(counts: Map<number, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  let bits = 0;
  for (const count of counts.values()) bits += count * Math.log2(total / count);
  return bits + counts.size * TABLE_BITS_PER_SYMBOL;
}

export function compressedPayloadSize(data: Uint8Array): number {
  const literals = new Map<number, number>();
  const lengths = new Map<number, number>();
  const distances = new Map<number, number>();
  let extraBits = 0;
  for (const token of tokenize(data)) {
    if (token.literal >= 0) {
      literals.set(token.literal, (literals.get(token.literal) ?? 0) + 1);
      continue;
    }
    const symbol = lengthSymbol(token.length);
    lengths.set(symbol, (lengths.get(symbol) ?? 0) + 1);
    extraBits += LENGTH_EXTRA[symbol];
    const distance = distanceSymbol(token.distance);
    distances.set(distance.symbol, (distances.get(distance.symbol) ?? 0) + 1);
    extraBits += distance.extra;
  }
  const bits = entropyBits(literals) + entropyBits(lengths) + entropyBits(distances) + extraBits;
  return Math.ceil((bits / 8) * STAND_IN_SCALE) + STAND_IN_FRAME_BYTES;
}
