import { ReverseBitWriter } from './BitStreams';
import { buildFseEncoder, entropyBits, fseEncode, fseInitialState, normalizeCounts, writeFseDescription, type FseEncoderTable } from './Fse';
import { buildCode, describeTree, encodeStream } from './Huffman';
import { initialRepeatHistory, offsetValueFor, resolveOffset, type RepeatHistory } from './RepeatOffsets';
import {
  BLOCK_MAX, LL_BASELINE, LL_DEFAULT, LL_DEFAULT_ACCURACY, LL_EXTRA_BITS, MAGIC, MAX_LL_ACCURACY, MAX_ML_ACCURACY, MAX_OF_ACCURACY, ML_BASELINE, ML_DEFAULT,
  ML_DEFAULT_ACCURACY, ML_EXTRA_BITS, OF_DEFAULT, OF_DEFAULT_ACCURACY,
} from './ZstdTables';

const MIN_MATCH = 4;
const HASH_BITS = 16;
const CHAIN_DEPTH = 24;
const MAX_DIRECT_SYMBOL = 128;
const LONG_OFFSET_FLOOR = 4096;

interface Sequence {
  readonly literalLength: number;
  readonly matchLength: number;
  readonly offsetValue: number;
}

let encoders: { readonly ll: FseEncoderTable; readonly of: FseEncoderTable; readonly ml: FseEncoderTable } | null = null;

function defaultEncoders(): { readonly ll: FseEncoderTable; readonly of: FseEncoderTable; readonly ml: FseEncoderTable } {
  encoders ??= {
    ll: buildFseEncoder(LL_DEFAULT, LL_DEFAULT_ACCURACY), of: buildFseEncoder(OF_DEFAULT, OF_DEFAULT_ACCURACY), ml: buildFseEncoder(ML_DEFAULT, ML_DEFAULT_ACCURACY),
  };
  return encoders;
}

function codeOf(value: number, baselines: readonly number[]): number {
  let code = baselines.length - 1;
  while (baselines[code] > value) code--;
  return code;
}

function hash4(bytes: Uint8Array, at: number): number {
  const value = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  return Math.imul(value, 0x9e3779b1) >>> (32 - HASH_BITS);
}

class MatchFinder {
  private readonly head = new Int32Array(1 << HASH_BITS).fill(-1);
  private readonly previous: Int32Array;

  constructor(private readonly bytes: Uint8Array) {
    this.previous = new Int32Array(bytes.length).fill(-1);
  }

  insert(at: number): void {
    if (at + MIN_MATCH > this.bytes.length) return;
    const slot = hash4(this.bytes, at);
    this.previous[at] = this.head[slot];
    this.head[slot] = at;
  }

  best(at: number, limit: number): { readonly length: number; readonly offset: number } {
    let bestLength = 0;
    let bestOffset = 0;
    if (at + MIN_MATCH > limit) return { length: 0, offset: 0 };
    let candidate = this.head[hash4(this.bytes, at)];
    for (let depth = 0; candidate >= 0 && depth < CHAIN_DEPTH; depth++) {
      let length = 0;
      while (at + length < limit && this.bytes[candidate + length] === this.bytes[at + length]) length++;
      const offset = at - candidate;
      const worthIt = length > MIN_MATCH || offset < LONG_OFFSET_FLOOR;
      if (worthIt && length > bestLength) {
        bestLength = length;
        bestOffset = offset;
      }
      candidate = this.previous[candidate];
    }
    return bestLength >= MIN_MATCH ? { length: bestLength, offset: bestOffset } : { length: 0, offset: 0 };
  }
}

function findSequences(finder: MatchFinder, bytes: Uint8Array, start: number, end: number, history: RepeatHistory): { sequences: Sequence[]; literals: Uint8Array } {
  const sequences: Sequence[] = [];
  const literalParts: Uint8Array[] = [];
  let anchor = start;
  let at = start;
  const repeatMatch = (position: number): { readonly length: number; readonly offset: number } => {
    let best = { length: 0, offset: 0 };
    for (const offset of history) {
      if (offset > position) continue;
      let length = 0;
      while (position + length < end && bytes[position + length - offset] === bytes[position + length]) length++;
      if (length > best.length) best = { length, offset };
    }
    return best.length >= MIN_MATCH ? best : { length: 0, offset: 0 };
  };
  const candidate = (position: number): { readonly length: number; readonly offset: number } => {
    const repeated = repeatMatch(position);
    const found = finder.best(position, end);
    return repeated.length > 0 && repeated.length + 1 >= found.length ? repeated : found;
  };
  while (at < end) {
    let match = candidate(at);
    if (match.length === 0) {
      finder.insert(at);
      at++;
      continue;
    }
    if (at + 1 < end) {
      finder.insert(at);
      const next = candidate(at + 1);
      if (next.length > match.length + 1) {
        at++;
        match = next;
      }
    }
    const literalLength = at - anchor;
    literalParts.push(bytes.subarray(anchor, at));
    const offsetValue = offsetValueFor(match.offset, literalLength, history);
    resolveOffset(offsetValue, literalLength, history);
    sequences.push({ literalLength, matchLength: match.length, offsetValue });
    for (let index = 0; index < match.length; index++) finder.insert(at + index);
    at += match.length;
    anchor = at;
  }
  literalParts.push(bytes.subarray(anchor, end));
  const total = literalParts.reduce((sum, part) => sum + part.length, 0);
  const literals = new Uint8Array(total);
  let written = 0;
  for (const part of literalParts) {
    literals.set(part, written);
    written += part.length;
  }
  return { sequences, literals };
}

function rawLiterals(literals: Uint8Array): Uint8Array {
  const size = literals.length;
  let header: number[];
  if (size < 32) header = [size << 3];
  else if (size < 4096) header = [((size & 15) << 4) | 4, size >> 4];
  else header = [((size & 15) << 4) | 12, (size >> 4) & 255, size >> 12];
  return Uint8Array.from([...header, ...literals]);
}

function rleLiterals(byte: number, size: number): Uint8Array {
  let header: number[];
  if (size < 32) header = [1 | (size << 3)];
  else if (size < 4096) header = [1 | 4 | ((size & 15) << 4), size >> 4];
  else header = [1 | 12 | ((size & 15) << 4), (size >> 4) & 255, size >> 12];
  return Uint8Array.from([...header, byte]);
}

function huffmanLiterals(literals: Uint8Array): Uint8Array | null {
  const frequencies = new Array<number>(Math.max(...literals) + 1).fill(0);
  for (const byte of literals) frequencies[byte]++;
  if (frequencies.length > MAX_DIRECT_SYMBOL + 1) return null;
  const code = buildCode(frequencies);
  if (code === null) return null;
  const tree = describeTree(code);
  const size = literals.length;
  const streams: Uint8Array[] = [];
  let format: number;
  if (size < 256) {
    streams.push(encodeStream(code, literals));
    format = 0;
  } else {
    const segment = Math.ceil(size / 4);
    for (let index = 0; index < 4; index++) streams.push(encodeStream(code, literals.subarray(index * segment, Math.min(size, (index + 1) * segment))));
    format = size < 1024 ? 1 : size < 16384 ? 2 : 3;
  }
  const jump = streams.length === 4 ? Uint8Array.of(streams[0].length & 255, streams[0].length >> 8, streams[1].length & 255, streams[1].length >> 8, streams[2].length & 255, streams[2].length >> 8) : new Uint8Array(0);
  const compressed = tree.length + jump.length + streams.reduce((sum, stream) => sum + stream.length, 0);
  const bits = [10, 10, 14, 18][format];
  if (size >= 2 ** bits || compressed >= 2 ** bits) return null;
  const headerLength = [3, 3, 4, 5][format];
  let header = BigInt(2) | (BigInt(format) << 2n) | (BigInt(size) << 4n) | (BigInt(compressed) << BigInt(4 + bits));
  const headerBytes: number[] = [];
  for (let index = 0; index < headerLength; index++) {
    headerBytes.push(Number(header & 255n));
    header >>= 8n;
  }
  return Uint8Array.from([...headerBytes, ...tree, ...jump, ...streams.flatMap((stream) => [...stream])]);
}

function literalsSection(literals: Uint8Array): Uint8Array {
  const raw = rawLiterals(literals);
  if (literals.length >= 2 && literals.every((byte) => byte === literals[0])) return rleLiterals(literals[0], literals.length);
  if (literals.length < 16) return raw;
  const huffman = huffmanLiterals(literals);
  return huffman !== null && huffman.length < raw.length ? huffman : raw;
}

interface TableChoice {
  readonly mode: number;
  readonly description: Uint8Array;
  readonly encoder: FseEncoderTable;
}

function optimalAccuracy(sequenceCount: number, maxSymbol: number, maxAccuracy: number): number {
  const sourceBits = 31 - Math.clz32(Math.max(1, sequenceCount - 1)) - 2;
  const minimumBits = Math.min(31 - Math.clz32(Math.max(1, sequenceCount - 1)) + 1, 31 - Math.clz32(Math.max(1, maxSymbol)) + 2);
  let accuracy = maxAccuracy;
  if (sourceBits < accuracy) accuracy = sourceBits;
  if (minimumBits > accuracy) accuracy = minimumBits;
  return Math.max(5, Math.min(maxAccuracy, accuracy));
}

function chooseTable(codes: readonly number[], defaults: readonly number[], defaultAccuracy: number, maxAccuracy: number, predefined: FseEncoderTable): TableChoice {
  const maxSymbol = Math.max(...codes);
  const histogram = new Array<number>(maxSymbol + 1).fill(0);
  for (const code of codes) histogram[code]++;
  if (histogram.filter((count) => count > 0).length === 1) {
    const single = new Array<number>(maxSymbol + 1).fill(0);
    single[maxSymbol] = 1;
    return { mode: 1, description: Uint8Array.of(maxSymbol), encoder: buildFseEncoder(single, 0) };
  }
  const predefinedBits = entropyBits(histogram, defaults, defaultAccuracy);
  const accuracy = optimalAccuracy(codes.length, maxSymbol, maxAccuracy);
  const normalized = normalizeCounts(histogram, accuracy);
  if (normalized === null) return { mode: 0, description: new Uint8Array(0), encoder: predefined };
  const description = writeFseDescription(normalized, accuracy);
  const customBits = description.length * 8 + entropyBits(histogram, normalized, accuracy);
  if (customBits >= predefinedBits) return { mode: 0, description: new Uint8Array(0), encoder: predefined };
  return { mode: 2, description, encoder: buildFseEncoder(normalized, accuracy) };
}

function sequencesSection(sequences: readonly Sequence[]): Uint8Array {
  const count = sequences.length;
  const header: number[] = [];
  if (count < 128) header.push(count);
  else if (count < 0x7f00) header.push((count >> 8) + 128, count & 255);
  else header.push(255, (count - 0x7f00) & 255, (count - 0x7f00) >> 8);
  if (count === 0) return Uint8Array.from(header);
  const codes = sequences.map((sequence) => {
    const offsetValue = sequence.offsetValue;
    const offsetCode = 31 - Math.clz32(offsetValue);
    const matchCode = codeOf(sequence.matchLength, ML_BASELINE);
    const literalCode = codeOf(sequence.literalLength, LL_BASELINE);
    return {
      offsetCode, offsetExtra: offsetValue - 2 ** offsetCode, matchCode, matchExtra: sequence.matchLength - ML_BASELINE[matchCode], literalCode,
      literalExtra: sequence.literalLength - LL_BASELINE[literalCode],
    };
  });
  const defaults = defaultEncoders();
  const ll = chooseTable(codes.map((code) => code.literalCode), LL_DEFAULT, LL_DEFAULT_ACCURACY, MAX_LL_ACCURACY, defaults.ll);
  const of = chooseTable(codes.map((code) => code.offsetCode), OF_DEFAULT, OF_DEFAULT_ACCURACY, MAX_OF_ACCURACY, defaults.of);
  const ml = chooseTable(codes.map((code) => code.matchCode), ML_DEFAULT, ML_DEFAULT_ACCURACY, MAX_ML_ACCURACY, defaults.ml);
  header.push((ll.mode << 6) | (of.mode << 4) | (ml.mode << 2));
  const writer = new ReverseBitWriter();
  const last = codes[count - 1];
  let stateLL = fseInitialState(ll.encoder, last.literalCode);
  let stateOF = fseInitialState(of.encoder, last.offsetCode);
  let stateML = fseInitialState(ml.encoder, last.matchCode);
  writer.addBits(last.literalExtra, LL_EXTRA_BITS[last.literalCode]);
  writer.addBits(last.matchExtra, ML_EXTRA_BITS[last.matchCode]);
  writer.addBits(last.offsetExtra, last.offsetCode);
  for (let index = count - 2; index >= 0; index--) {
    const code = codes[index];
    const offsetStep = fseEncode(of.encoder, stateOF, code.offsetCode);
    writer.addBits(offsetStep.bits, offsetStep.count);
    stateOF = offsetStep.next;
    const matchStep = fseEncode(ml.encoder, stateML, code.matchCode);
    writer.addBits(matchStep.bits, matchStep.count);
    stateML = matchStep.next;
    const literalStep = fseEncode(ll.encoder, stateLL, code.literalCode);
    writer.addBits(literalStep.bits, literalStep.count);
    stateLL = literalStep.next;
    writer.addBits(code.literalExtra, LL_EXTRA_BITS[code.literalCode]);
    writer.addBits(code.matchExtra, ML_EXTRA_BITS[code.matchCode]);
    writer.addBits(code.offsetExtra, code.offsetCode);
  }
  writer.addBits(stateML, ml.encoder.accuracyLog);
  writer.addBits(stateOF, of.encoder.accuracyLog);
  writer.addBits(stateLL, ll.encoder.accuracyLog);
  return Uint8Array.from([...header, ...ll.description, ...of.description, ...ml.description, ...writer.close()]);
}

function blockHeader(last: boolean, type: number, size: number): number[] {
  const value = (last ? 1 : 0) | (type << 1) | (size << 3);
  return [value & 255, (value >> 8) & 255, (value >> 16) & 255];
}

function encodeBlock(bytes: Uint8Array, finder: MatchFinder, start: number, end: number, last: boolean, history: RepeatHistory): Uint8Array {
  const size = end - start;
  const raw = Uint8Array.from([...blockHeader(last, 0, size), ...bytes.subarray(start, end)]);
  if (size > 1 && bytes.subarray(start, end).every((byte) => byte === bytes[start])) return Uint8Array.from([...blockHeader(last, 1, size), bytes[start]]);
  const saved: RepeatHistory = [history[0], history[1], history[2]];
  const { sequences, literals } = findSequences(finder, bytes, start, end, history);
  const body = Uint8Array.from([...literalsSection(literals), ...sequencesSection(sequences)]);
  if (body.length + 3 >= raw.length || body.length >= BLOCK_MAX) {
    history[0] = saved[0];
    history[1] = saved[1];
    history[2] = saved[2];
    return raw;
  }
  return Uint8Array.from([...blockHeader(last, 2, body.length), ...body]);
}

function frameHeader(size: number): number[] {
  const magic = [MAGIC & 255, (MAGIC >> 8) & 255, (MAGIC >> 16) & 255, (MAGIC >>> 24) & 255];
  if (size < 256) return [...magic, 0x20, size];
  if (size < 65536 + 256) return [...magic, 0x60, (size - 256) & 255, (size - 256) >> 8];
  return [...magic, 0xa0, size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255];
}

export function zstdCompress(input: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(frameHeader(input.length))];
  if (input.length === 0) {
    parts.push(Uint8Array.from(blockHeader(true, 0, 0)));
  } else {
    const finder = new MatchFinder(input);
    const history = initialRepeatHistory();
    for (let start = 0; start < input.length; start += BLOCK_MAX) {
      const end = Math.min(input.length, start + BLOCK_MAX);
      parts.push(encodeBlock(input, finder, start, end, end === input.length, history));
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
