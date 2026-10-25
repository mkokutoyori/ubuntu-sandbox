import { ForwardBitReader } from './BitStreams';

export interface FseTable {
  readonly accuracyLog: number;
  readonly symbols: Uint8Array;
  readonly nbBits: Uint8Array;
  readonly baseline: Uint16Array;
}

export function buildFseTable(counts: ArrayLike<number>, accuracyLog: number): FseTable | null {
  const size = 1 << accuracyLog;
  const symbols = new Uint8Array(size);
  const symbolNext = new Uint16Array(counts.length);
  let highThreshold = size - 1;
  let total = 0;
  for (let symbol = 0; symbol < counts.length; symbol++) {
    if (counts[symbol] === -1) {
      symbols[highThreshold--] = symbol;
      symbolNext[symbol] = 1;
      total += 1;
    } else {
      symbolNext[symbol] = counts[symbol];
      total += counts[symbol];
    }
  }
  if (total !== size) return null;
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  for (let symbol = 0; symbol < counts.length; symbol++) {
    for (let index = 0; index < counts[symbol]; index++) {
      symbols[position] = symbol;
      do position = (position + step) & mask;
      while (position > highThreshold);
    }
  }
  if (position !== 0) return null;
  const nbBits = new Uint8Array(size);
  const baseline = new Uint16Array(size);
  for (let state = 0; state < size; state++) {
    const next = symbolNext[symbols[state]]++;
    nbBits[state] = accuracyLog - (31 - Math.clz32(next));
    baseline[state] = (next << nbBits[state]) - size;
  }
  return { accuracyLog, symbols, nbBits, baseline };
}

export interface FseDescription {
  readonly counts: number[];
  readonly accuracyLog: number;
  readonly consumed: number;
}

export function readFseDescription(bytes: Uint8Array, start: number, end: number, maxSymbol: number, maxAccuracyLog: number): FseDescription | null {
  const reader = new ForwardBitReader(bytes, start, end);
  const accuracyLog = reader.read(4) + 5;
  if (accuracyLog > maxAccuracyLog) return null;
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  const counts: number[] = [];
  let previousZero = false;
  while (remaining > 1 && counts.length <= maxSymbol) {
    if (previousZero) {
      let repeat = 0;
      for (;;) {
        const value = reader.read(2);
        repeat += value;
        if (value !== 3) break;
      }
      for (let index = 0; index < repeat; index++) counts.push(0);
      if (counts.length > maxSymbol + 1) return null;
      if (reader.overrun) return null;
    }
    const limit = 2 * threshold - 1 - remaining;
    const low = readPeek(bytes, start, end, reader.bitPosition, nbBits - 1) & (threshold - 1);
    let count: number;
    if (low < limit) {
      count = low;
      reader.read(nbBits - 1);
    } else {
      count = reader.read(nbBits) & (2 * threshold - 1);
      if (count >= threshold) count -= limit;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    counts.push(count);
    previousZero = count === 0;
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
    if (reader.overrun) return null;
  }
  if (remaining !== 1) return null;
  return { counts, accuracyLog, consumed: reader.consumedBytes };
}

function readPeek(bytes: Uint8Array, start: number, end: number, bitPosition: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index++) {
    const absolute = bitPosition + index;
    const byte = start + (absolute >> 3);
    const bit = byte < end ? (bytes[byte] >> (absolute & 7)) & 1 : 0;
    value += bit * 2 ** index;
  }
  return value;
}

export interface FseEncoderTable {
  readonly accuracyLog: number;
  readonly states: ReadonlyArray<readonly number[]>;
  readonly table: FseTable;
}

export function buildFseEncoder(counts: ArrayLike<number>, accuracyLog: number): FseEncoderTable {
  const table = buildFseTable(counts, accuracyLog) as FseTable;
  const states: number[][] = Array.from({ length: counts.length }, () => []);
  for (let state = 0; state < table.symbols.length; state++) states[table.symbols[state]].push(state);
  for (const list of states) list.sort((left, right) => table.baseline[left] - table.baseline[right]);
  return { accuracyLog, states, table };
}

export function fseInitialState(encoder: FseEncoderTable, symbol: number): number {
  return encoder.states[symbol][0];
}

export function fseEncode(encoder: FseEncoderTable, current: number, symbol: number): { readonly bits: number; readonly count: number; readonly next: number } {
  const { table } = encoder;
  for (const candidate of encoder.states[symbol]) {
    const width = table.nbBits[candidate];
    const base = table.baseline[candidate];
    if (current >= base && current < base + 2 ** width) return { bits: current - base, count: width, next: candidate };
  }
  throw new Error('state cannot encode the symbol');
}

export function normalizeCounts(histogram: readonly number[], accuracyLog: number): number[] | null {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  const size = 1 << accuracyLog;
  const present = histogram.filter((count) => count > 0).length;
  if (total === 0 || present < 2 || present > size) return null;
  const scaled = histogram.map((count) => (count === 0 ? 0 : Math.max(1, Math.round((count * size) / total))));
  let sum = scaled.reduce((acc, count) => acc + count, 0);
  const order = histogram.map((count, symbol) => ({ count, symbol })).sort((left, right) => right.count - left.count || left.symbol - right.symbol);
  for (let guard = 0; sum !== size && guard < 4 * size; guard++) {
    const target = order[guard % present].symbol;
    if (sum > size && scaled[target] > 1) {
      scaled[target]--;
      sum--;
    } else if (sum < size) {
      scaled[target]++;
      sum++;
    }
  }
  return sum === size ? scaled : null;
}

export function writeFseDescription(counts: readonly number[], accuracyLog: number): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, count: number): void => {
    for (let index = 0; index < count; index++) bits.push(Math.floor(value / 2 ** index) % 2);
  };
  put(accuracyLog - 5, 4);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  let previousZero = false;
  let symbol = 0;
  const alphabet = counts.length;
  while (symbol < alphabet && remaining > 1) {
    if (previousZero) {
      let run = 0;
      while (symbol + run < alphabet && counts[symbol + run] === 0) run++;
      symbol += run;
      let left = run;
      while (left >= 3) {
        put(3, 2);
        left -= 3;
      }
      put(left, 2);
      if (symbol >= alphabet) break;
    }
    const count = counts[symbol++];
    const limit = 2 * threshold - 1 - remaining;
    remaining -= count < 0 ? -count : count;
    let coded = count + 1;
    if (coded >= threshold) coded += limit;
    put(coded, coded < limit ? nbBits - 1 : nbBits);
    previousZero = coded === 1;
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
  }
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { if (bit === 1) out[index >> 3] |= 1 << (index & 7); });
  return out;
}

export function entropyBits(histogram: readonly number[], counts: readonly number[], accuracyLog: number): number {
  let bits = 0;
  for (let symbol = 0; symbol < histogram.length; symbol++) {
    if (histogram[symbol] === 0) continue;
    const probability = Math.max(1, counts[symbol] ?? 0);
    if ((counts[symbol] ?? 0) === 0) return Number.POSITIVE_INFINITY;
    bits += histogram[symbol] * (accuracyLog - Math.log2(probability));
  }
  return bits;
}
