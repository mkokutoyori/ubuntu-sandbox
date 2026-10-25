import { ReverseBitReader } from './BitStreams';
import { buildFseTable, readFseDescription, type FseTable } from './Fse';
import { decodeStream, readWeights, tableFromWeights, type HuffmanTable } from './Huffman';
import {
  BLOCK_MAX, LL_BASELINE, LL_DEFAULT, LL_DEFAULT_ACCURACY, LL_EXTRA_BITS, MAGIC, MAX_LL_ACCURACY, MAX_LL_SYMBOL, MAX_ML_ACCURACY, MAX_ML_SYMBOL, MAX_OF_ACCURACY,
  MAX_OF_SYMBOL, ML_BASELINE, ML_DEFAULT, ML_DEFAULT_ACCURACY, ML_EXTRA_BITS, OF_DEFAULT, OF_DEFAULT_ACCURACY,
} from './ZstdTables';
import { xxh64 } from './Xxh64';

export type ZstdResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

class Corrupt extends Error {}

const fail = (reason: string): never => {
  throw new Corrupt(reason);
};

interface FrameState {
  huffman: HuffmanTable | null;
  literalLengths: FseTable | null;
  offsets: FseTable | null;
  matchLengths: FseTable | null;
  repeated: [number, number, number];
}

class Output {
  bytes: Uint8Array;
  length = 0;

  constructor(capacity: number, private readonly limit: number) {
    this.bytes = new Uint8Array(Math.min(Math.max(capacity, 1024), limit));
  }

  reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.limit) fail('output exceeds the limit');
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, this.limit));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  append(source: Uint8Array): void {
    this.reserve(source.length);
    this.bytes.set(source, this.length);
    this.length += source.length;
  }

  fill(value: number, count: number): void {
    this.reserve(count);
    this.bytes.fill(value, this.length, this.length + count);
    this.length += count;
  }

  copyMatch(offset: number, count: number): void {
    this.reserve(count);
    for (let index = 0; index < count; index++) this.bytes[this.length + index] = this.bytes[this.length + index - offset];
    this.length += count;
  }
}

const u32 = (bytes: Uint8Array, offset: number): number => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

function littleEndian(bytes: Uint8Array, offset: number, count: number): number {
  let value = 0;
  for (let index = count - 1; index >= 0; index--) value = value * 256 + bytes[offset + index];
  return value;
}

interface Literals {
  readonly bytes: Uint8Array;
  readonly next: number;
}

function parseLiterals(input: Uint8Array, start: number, end: number, state: FrameState): Literals {
  if (start >= end) fail('empty literals section');
  const first = input[start];
  const type = first & 3;
  const format = (first >> 2) & 3;
  if (type <= 1) {
    let regenerated: number;
    let header: number;
    if (format === 0 || format === 2) {
      regenerated = first >> 3;
      header = 1;
    } else if (format === 1) {
      if (start + 2 > end) fail('truncated literals header');
      regenerated = (first >> 4) + (input[start + 1] << 4);
      header = 2;
    } else {
      if (start + 3 > end) fail('truncated literals header');
      regenerated = (first >> 4) + (input[start + 1] << 4) + (input[start + 2] << 12);
      header = 3;
    }
    if (regenerated > BLOCK_MAX) fail('literals too large');
    if (type === 0) {
      if (start + header + regenerated > end) fail('truncated raw literals');
      return { bytes: input.subarray(start + header, start + header + regenerated), next: start + header + regenerated };
    }
    if (start + header + 1 > end) fail('truncated rle literals');
    return { bytes: new Uint8Array(regenerated).fill(input[start + header]), next: start + header + 1 };
  }
  let streams = 4;
  let header: number;
  let regenerated: number;
  let compressed: number;
  if (format === 0 || format === 1) {
    if (start + 3 > end) fail('truncated literals header');
    const value = littleEndian(input, start, 3);
    regenerated = (value >> 4) & 0x3ff;
    compressed = (value >> 14) & 0x3ff;
    header = 3;
    streams = format === 0 ? 1 : 4;
  } else if (format === 2) {
    if (start + 4 > end) fail('truncated literals header');
    const value = littleEndian(input, start, 4);
    regenerated = (value >>> 4) & 0x3fff;
    compressed = (value >>> 18) & 0x3fff;
    header = 4;
  } else {
    if (start + 5 > end) fail('truncated literals header');
    const value = littleEndian(input, start, 5);
    regenerated = Math.floor(value / 16) % 0x40000;
    compressed = Math.floor(value / 2 ** 22) % 0x40000;
    header = 5;
  }
  if (regenerated > BLOCK_MAX) fail('literals too large');
  const payloadStart = start + header;
  const payloadEnd = payloadStart + compressed;
  if (payloadEnd > end) fail('truncated compressed literals');
  let streamsStart = payloadStart;
  if (type === 2) {
    const description = readWeights(input, payloadStart, payloadEnd);
    if (description === null) return fail('bad huffman weights');
    const table = tableFromWeights(description.weights);
    if (table === null) return fail('bad huffman table');
    state.huffman = table;
    streamsStart += description.consumed;
  }
  const table = state.huffman;
  if (table === null) return fail('treeless literals without a table');
  if (streams === 1) {
    const decoded = decodeStream(table, input, streamsStart, payloadEnd, regenerated);
    if (decoded === null) return fail('bad huffman stream');
    return { bytes: decoded, next: payloadEnd };
  }
  if (streamsStart + 6 > payloadEnd) fail('truncated jump table');
  const sizes = [littleEndian(input, streamsStart, 2), littleEndian(input, streamsStart + 2, 2), littleEndian(input, streamsStart + 4, 2)];
  const rest = payloadEnd - streamsStart - 6 - sizes[0] - sizes[1] - sizes[2];
  if (rest < 0) fail('bad jump table');
  sizes.push(rest);
  const segment = Math.ceil(regenerated / 4);
  const counts = [segment, segment, segment, regenerated - 3 * segment];
  if (counts[3] < 0) fail('bad stream split');
  const out = new Uint8Array(regenerated);
  let at = streamsStart + 6;
  let written = 0;
  for (let index = 0; index < 4; index++) {
    const decoded = decodeStream(table, input, at, at + sizes[index], counts[index]);
    if (decoded === null) return fail('bad huffman stream');
    out.set(decoded, written);
    written += counts[index];
    at += sizes[index];
  }
  return { bytes: out, next: payloadEnd };
}

function rleTable(symbol: number): FseTable {
  return { accuracyLog: 0, symbols: Uint8Array.of(symbol), nbBits: Uint8Array.of(0), baseline: Uint16Array.of(0) };
}

function sequenceTable(mode: number, input: Uint8Array, at: number, end: number, defaults: readonly number[], defaultAccuracy: number, maxSymbol: number, maxAccuracy: number, previous: FseTable | null): { table: FseTable; next: number } {
  if (mode === 0) return { table: buildFseTable(defaults, defaultAccuracy) as FseTable, next: at };
  if (mode === 1) {
    if (at >= end) fail('truncated rle table');
    if (input[at] > maxSymbol) fail('rle symbol out of range');
    return { table: rleTable(input[at]), next: at + 1 };
  }
  if (mode === 3) {
    if (previous === null) return fail('repeat table without a previous one');
    return { table: previous, next: at };
  }
  const description = readFseDescription(input, at, end, maxSymbol, maxAccuracy);
  if (description === null) return fail('bad table description');
  const table = buildFseTable(description.counts, description.accuracyLog);
  if (table === null) return fail('bad table');
  return { table, next: at + description.consumed };
}

function decodeBlock(input: Uint8Array, start: number, end: number, output: Output, windowSize: number, state: FrameState): void {
  const literals = parseLiterals(input, start, end, state);
  let at = literals.next;
  if (at >= end) fail('missing sequences section');
  let count = input[at++];
  if (count === 0) {
    output.append(literals.bytes);
    if (at !== end) fail('trailing bytes after an empty sequences section');
    return;
  }
  if (count === 255) {
    if (at + 2 > end) fail('truncated sequence count');
    count = input[at] + (input[at + 1] << 8) + 0x7f00;
    at += 2;
  } else if (count >= 128) {
    if (at >= end) fail('truncated sequence count');
    count = ((count - 128) << 8) + input[at++];
  }
  if (at >= end) fail('missing compression modes');
  const modes = input[at++];
  if ((modes & 3) !== 0) fail('reserved bits in the compression modes');
  const ll = sequenceTable((modes >> 6) & 3, input, at, end, LL_DEFAULT, LL_DEFAULT_ACCURACY, MAX_LL_SYMBOL, MAX_LL_ACCURACY, state.literalLengths);
  const of = sequenceTable((modes >> 4) & 3, input, ll.next, end, OF_DEFAULT, OF_DEFAULT_ACCURACY, MAX_OF_SYMBOL, MAX_OF_ACCURACY, state.offsets);
  const ml = sequenceTable((modes >> 2) & 3, input, of.next, end, ML_DEFAULT, ML_DEFAULT_ACCURACY, MAX_ML_SYMBOL, MAX_ML_ACCURACY, state.matchLengths);
  state.literalLengths = ll.table;
  state.offsets = of.table;
  state.matchLengths = ml.table;
  const reader = new ReverseBitReader(input, ml.next, end);
  if (!reader.valid) fail('empty sequence bitstream');
  let llState = reader.read(ll.table.accuracyLog);
  let ofState = reader.read(of.table.accuracyLog);
  let mlState = reader.read(ml.table.accuracyLog);
  let literalPosition = 0;
  const repeated = state.repeated;
  for (let index = 0; index < count; index++) {
    const ofCode = of.table.symbols[ofState];
    const mlCode = ml.table.symbols[mlState];
    const llCode = ll.table.symbols[llState];
    if (ofCode > MAX_OF_SYMBOL || mlCode > MAX_ML_SYMBOL || llCode > MAX_LL_SYMBOL) fail('symbol out of range');
    const offsetValue = 2 ** ofCode + reader.read(ofCode);
    const matchLength = ML_BASELINE[mlCode] + reader.read(ML_EXTRA_BITS[mlCode]);
    const literalLength = LL_BASELINE[llCode] + reader.read(LL_EXTRA_BITS[llCode]);
    if (index < count - 1) {
      llState = ll.table.baseline[llState] + reader.read(ll.table.nbBits[llState]);
      mlState = ml.table.baseline[mlState] + reader.read(ml.table.nbBits[mlState]);
      ofState = of.table.baseline[ofState] + reader.read(of.table.nbBits[ofState]);
    }
    if (reader.overrun) fail('sequence bitstream overrun');
    let offset: number;
    if (offsetValue > 3) {
      offset = offsetValue - 3;
      repeated[2] = repeated[1];
      repeated[1] = repeated[0];
      repeated[0] = offset;
    } else {
      const slot = offsetValue - 1 + (literalLength === 0 ? 1 : 0);
      if (slot === 0) offset = repeated[0];
      else {
        offset = slot === 3 ? repeated[0] - 1 : repeated[slot];
        if (offset === 0) fail('zero repeat offset');
        if (slot !== 1) repeated[2] = repeated[1];
        repeated[1] = repeated[0];
        repeated[0] = offset;
      }
    }
    if (literalPosition + literalLength > literals.bytes.length) fail('literal length exceeds the literals');
    output.append(literals.bytes.subarray(literalPosition, literalPosition + literalLength));
    literalPosition += literalLength;
    if (offset > output.length || offset > Math.max(windowSize, BLOCK_MAX)) fail('offset beyond the window');
    output.copyMatch(offset, matchLength);
  }
  if (!reader.exhausted) fail('sequence bitstream not fully consumed');
  output.append(literals.bytes.subarray(literalPosition));
}

function decodeFrame(input: Uint8Array, start: number, output: Output): number {
  if (start + 5 > input.length) fail('truncated frame header');
  const descriptor = input[start + 4];
  const sizeFlag = descriptor >> 6;
  const singleSegment = ((descriptor >> 5) & 1) === 1;
  if ((descriptor & 0x08) !== 0) fail('reserved bit set');
  const checksum = ((descriptor >> 2) & 1) === 1;
  const dictionary = [0, 1, 2, 4][descriptor & 3];
  let at = start + 5;
  let windowSize = 0;
  if (!singleSegment) {
    if (at >= input.length) fail('truncated window descriptor');
    const window = input[at++];
    const base = 2 ** (10 + (window >> 3));
    windowSize = base + (base / 8) * (window & 7);
  }
  if (dictionary > 0) {
    if (littleEndian(input, at, dictionary) !== 0) fail('dictionary frames are not supported');
    at += dictionary;
  }
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
  if (at + sizeBytes > input.length) fail('truncated content size');
  let contentSize: number | null = null;
  if (sizeBytes > 0) contentSize = littleEndian(input, at, sizeBytes) + (sizeFlag === 1 ? 256 : 0);
  at += sizeBytes;
  if (singleSegment) windowSize = contentSize ?? 0;
  const frameStart = output.length;
  const state: FrameState = { huffman: null, literalLengths: null, offsets: null, matchLengths: null, repeated: [1, 4, 8] };
  const blockMaximum = Math.min(windowSize, BLOCK_MAX);
  for (;;) {
    if (at + 3 > input.length) fail('truncated block header');
    const header = littleEndian(input, at, 3);
    at += 3;
    const last = (header & 1) === 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 3) fail('reserved block type');
    if (type !== 1 && size > blockMaximum) fail('block exceeds the maximum size');
    if (type === 0) {
      if (at + size > input.length) fail('truncated raw block');
      output.append(input.subarray(at, at + size));
      at += size;
    } else if (type === 1) {
      if (at >= input.length) fail('truncated rle block');
      if (size > BLOCK_MAX && size > blockMaximum) fail('rle block exceeds the maximum size');
      output.fill(input[at], size);
      at += 1;
    } else {
      if (at + size > input.length) fail('truncated compressed block');
      decodeBlock(input, at, at + size, output, windowSize, state);
      at += size;
    }
    if (last) break;
  }
  const produced = output.length - frameStart;
  if (contentSize !== null && contentSize !== produced) fail('content size mismatch');
  if (checksum) {
    if (at + 4 > input.length) fail('truncated checksum');
    const expected = u32(input, at);
    const actual = Number(xxh64(output.bytes.subarray(frameStart, output.length)) & 0xffffffffn);
    if (expected !== actual) fail('checksum mismatch');
    at += 4;
  }
  return at;
}

export function zstdDecompress(input: Uint8Array, limit = 1 << 30): ZstdResult {
  const output = new Output(input.length * 4, limit);
  try {
    let at = 0;
    if (input.length === 0) return { ok: false, reason: 'empty input' };
    while (at < input.length) {
      if (at + 4 > input.length) fail('truncated magic number');
      const magic = u32(input, at);
      if (magic === MAGIC) at = decodeFrame(input, at, output);
      else if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
        if (at + 8 > input.length) fail('truncated skippable frame');
        at += 8 + u32(input, at + 4);
        if (at > input.length) fail('truncated skippable frame');
      } else fail('bad magic number');
    }
    return { ok: true, bytes: output.bytes.slice(0, output.length) };
  } catch (error) {
    if (error instanceof Corrupt) return { ok: false, reason: error.message };
    throw error;
  }
}
