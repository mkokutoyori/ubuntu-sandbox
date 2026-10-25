import { ReverseBitReader, ReverseBitWriter } from './BitStreams';
import { buildFseTable, readFseDescription } from './Fse';

export const MAX_HUFFMAN_BITS = 11;
const MAX_DIRECT_WEIGHTS = 128;

export interface HuffmanTable {
  readonly maxBits: number;
  readonly symbols: Uint8Array;
  readonly lengths: Uint8Array;
}

export function tableFromWeights(weights: ArrayLike<number>): HuffmanTable | null {
  let sum = 0;
  for (let index = 0; index < weights.length; index++) if (weights[index] > 0) sum += 2 ** (weights[index] - 1);
  if (sum === 0) return null;
  const maxBits = 32 - Math.clz32(sum);
  if (maxBits > MAX_HUFFMAN_BITS) return null;
  const rest = 2 ** maxBits - sum;
  if (rest <= 0 || (rest & (rest - 1)) !== 0) return null;
  const all = [...Array.from(weights), (31 - Math.clz32(rest)) + 1];
  const size = 1 << maxBits;
  const symbols = new Uint8Array(size);
  const lengths = new Uint8Array(size);
  let position = 0;
  for (let weight = 1; weight <= maxBits; weight++) {
    for (let symbol = 0; symbol < all.length; symbol++) {
      if (all[symbol] !== weight) continue;
      const span = 2 ** (weight - 1);
      for (let index = 0; index < span; index++) {
        symbols[position + index] = symbol;
        lengths[position + index] = maxBits + 1 - weight;
      }
      position += span;
    }
  }
  return position === size ? { maxBits, symbols, lengths } : null;
}

export interface WeightsResult {
  readonly weights: number[];
  readonly consumed: number;
}

export function readWeights(bytes: Uint8Array, start: number, end: number): WeightsResult | null {
  if (start >= end) return null;
  const header = bytes[start];
  if (header >= 128) {
    const count = header - 127;
    const used = Math.ceil(count / 2);
    if (start + 1 + used > end) return null;
    const weights: number[] = [];
    for (let index = 0; index < count; index++) {
      const byte = bytes[start + 1 + (index >> 1)];
      weights.push(index % 2 === 0 ? byte >> 4 : byte & 15);
    }
    return { weights, consumed: 1 + used };
  }
  if (start + 1 + header > end) return null;
  const description = readFseDescription(bytes, start + 1, start + 1 + header, 12, 6);
  if (description === null) return null;
  const table = buildFseTable(description.counts, description.accuracyLog);
  if (table === null) return null;
  const reader = new ReverseBitReader(bytes, start + 1 + description.consumed, start + 1 + header);
  if (!reader.valid) return null;
  let state1 = reader.read(table.accuracyLog);
  let state2 = reader.read(table.accuracyLog);
  const weights: number[] = [];
  for (;;) {
    weights.push(table.symbols[state1]);
    state1 = table.baseline[state1] + reader.read(table.nbBits[state1]);
    if (reader.overrun) {
      weights.push(table.symbols[state2]);
      break;
    }
    weights.push(table.symbols[state2]);
    state2 = table.baseline[state2] + reader.read(table.nbBits[state2]);
    if (reader.overrun) {
      weights.push(table.symbols[state1]);
      break;
    }
    if (weights.length > 255) return null;
  }
  return weights.length > 255 ? null : { weights, consumed: 1 + header };
}

export function decodeStream(table: HuffmanTable, bytes: Uint8Array, start: number, end: number, count: number): Uint8Array | null {
  const reader = new ReverseBitReader(bytes, start, end);
  if (!reader.valid) return null;
  const out = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const prefix = reader.peek(table.maxBits);
    out[index] = table.symbols[prefix];
    reader.skip(table.lengths[prefix]);
  }
  return reader.exhausted ? out : null;
}

export interface HuffmanCode {
  readonly weights: number[];
  readonly codes: Uint16Array;
  readonly lengths: Uint8Array;
  readonly lastSymbol: number;
}

function limitedLengths(frequencies: readonly number[]): number[] | null {
  const present = frequencies.map((count, symbol) => ({ count, symbol })).filter((entry) => entry.count > 0);
  if (present.length < 2) return null;
  let counts = present.map((entry) => entry.count);
  for (let attempt = 0; attempt < 16; attempt++) {
    const lengths = huffmanLengths(counts);
    if (Math.max(...lengths) <= MAX_HUFFMAN_BITS) {
      const result = new Array<number>(frequencies.length).fill(0);
      present.forEach((entry, index) => { result[entry.symbol] = lengths[index]; });
      return result;
    }
    counts = counts.map((count) => Math.max(1, count >> 1));
  }
  return null;
}

function huffmanLengths(counts: readonly number[]): number[] {
  interface Node { weight: number; symbols: number[] }
  let nodes: Node[] = counts.map((weight, index) => ({ weight, symbols: [index] }));
  const lengths = new Array<number>(counts.length).fill(0);
  while (nodes.length > 1) {
    nodes.sort((left, right) => left.weight - right.weight || left.symbols[0] - right.symbols[0]);
    const [first, second, ...rest] = nodes;
    for (const symbol of [...first.symbols, ...second.symbols]) lengths[symbol]++;
    nodes = [...rest, { weight: first.weight + second.weight, symbols: [...first.symbols, ...second.symbols] }];
  }
  return lengths;
}

export function buildCode(frequencies: readonly number[]): HuffmanCode | null {
  if (frequencies.length > MAX_DIRECT_WEIGHTS + 1) return null;
  const lengths = limitedLengths(frequencies);
  if (lengths === null) return null;
  const maxBits = Math.max(...lengths);
  const weights = lengths.map((length) => (length === 0 ? 0 : maxBits + 1 - length));
  const lastSymbol = weights.reduce((last, weight, symbol) => (weight > 0 ? symbol : last), 0);
  const explicit = weights.slice(0, lastSymbol);
  const table = tableFromWeights(explicit);
  if (table === null || table.maxBits !== maxBits) return null;
  const codes = new Uint16Array(frequencies.length);
  const bitLengths = new Uint8Array(frequencies.length);
  let position = 0;
  for (let weight = 1; weight <= maxBits; weight++) {
    for (let symbol = 0; symbol < weights.length; symbol++) {
      if (weights[symbol] !== weight) continue;
      codes[symbol] = position >> (weight - 1);
      bitLengths[symbol] = maxBits + 1 - weight;
      position += 2 ** (weight - 1);
    }
  }
  return { weights: explicit, codes, lengths: bitLengths, lastSymbol };
}

export function describeTree(code: HuffmanCode): Uint8Array {
  const count = code.weights.length;
  const out = new Uint8Array(1 + Math.ceil(count / 2));
  out[0] = 127 + count;
  code.weights.forEach((weight, index) => { out[1 + (index >> 1)] |= index % 2 === 0 ? weight << 4 : weight; });
  return out;
}

export function encodeStream(code: HuffmanCode, literals: Uint8Array): Uint8Array {
  const writer = new ReverseBitWriter();
  for (let index = literals.length - 1; index >= 0; index--) writer.addBits(code.codes[literals[index]], code.lengths[literals[index]]);
  return writer.close();
}
