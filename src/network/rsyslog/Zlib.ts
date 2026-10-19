const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const WINDOW_SIZE = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_STORED_BLOCK = 65535;
const ADLER_MODULUS = 65521;

export class ZlibError extends Error {}

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % ADLER_MODULUS;
    b = (b + a) % ADLER_MODULUS;
  }
  return ((b << 16) | a) >>> 0;
}

class BitWriter {
  private readonly bytes: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;

  bits(value: number, count: number): void {
    for (let index = 0; index < count; index++) {
      this.bitBuffer |= ((value >>> index) & 1) << this.bitCount;
      if (++this.bitCount === 8) this.flushByte();
    }
  }

  huffman(code: number, length: number): void {
    for (let index = length - 1; index >= 0; index--) {
      this.bitBuffer |= ((code >>> index) & 1) << this.bitCount;
      if (++this.bitCount === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.bitBuffer);
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  alignToByte(): void {
    if (this.bitCount > 0) this.flushByte();
  }

  raw(bytes: Uint8Array): void {
    for (const byte of bytes) this.bytes.push(byte);
  }

  finish(): number[] {
    this.alignToByte();
    return this.bytes;
  }
}

function fixedLiteralCode(symbol: number): { code: number; length: number } {
  if (symbol < 144) return { code: 0x30 + symbol, length: 8 };
  if (symbol < 256) return { code: 0x190 + (symbol - 144), length: 9 };
  if (symbol < 280) return { code: symbol - 256, length: 7 };
  return { code: 0xc0 + (symbol - 280), length: 8 };
}

function lengthSymbol(length: number): number {
  let symbol = LENGTH_BASE.length - 1;
  while (LENGTH_BASE[symbol] > length) symbol--;
  return symbol;
}

function distanceSymbol(distance: number): number {
  let symbol = DISTANCE_BASE.length - 1;
  while (DISTANCE_BASE[symbol] > distance) symbol--;
  return symbol;
}

function chainLimit(level: number): number {
  if (level <= 1) return 4;
  if (level <= 3) return 8;
  if (level <= 5) return 32;
  if (level <= 7) return 128;
  return 1024;
}

function hash3(data: Uint8Array, position: number): number {
  return ((data[position] << 16) | (data[position + 1] << 8) | data[position + 2]) % 65537;
}

function deflateFixed(data: Uint8Array, level: number): number[] {
  const writer = new BitWriter();
  writer.bits(1, 1);
  writer.bits(1, 2);
  const heads = new Map<number, number[]>();
  const limit = chainLimit(level);
  let position = 0;
  const emitLiteral = (symbol: number): void => {
    const { code, length } = fixedLiteralCode(symbol);
    writer.huffman(code, length);
  };
  const insert = (at: number): void => {
    if (at + MIN_MATCH > data.length) return;
    const key = hash3(data, at);
    const chain = heads.get(key);
    if (chain === undefined) heads.set(key, [at]);
    else chain.push(at);
  };
  while (position < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (position + MIN_MATCH <= data.length) {
      const chain = heads.get(hash3(data, position));
      if (chain !== undefined) {
        let examined = 0;
        for (let index = chain.length - 1; index >= 0 && examined < limit; index--, examined++) {
          const candidate = chain[index];
          const distance = position - candidate;
          if (distance > WINDOW_SIZE) break;
          let length = 0;
          const maximum = Math.min(MAX_MATCH, data.length - position);
          while (length < maximum && data[candidate + length] === data[position + length]) length++;
          if (length > bestLength) {
            bestLength = length;
            bestDistance = distance;
            if (length === maximum) break;
          }
        }
      }
    }
    if (bestLength >= MIN_MATCH) {
      const lengthIndex = lengthSymbol(bestLength);
      emitLiteral(257 + lengthIndex);
      writer.bits(bestLength - LENGTH_BASE[lengthIndex], LENGTH_EXTRA[lengthIndex]);
      const distanceIndex = distanceSymbol(bestDistance);
      writer.huffman(distanceIndex, 5);
      writer.bits(bestDistance - DISTANCE_BASE[distanceIndex], DISTANCE_EXTRA[distanceIndex]);
      for (let advance = 0; advance < bestLength; advance++) insert(position + advance);
      position += bestLength;
    } else {
      emitLiteral(data[position]);
      insert(position);
      position++;
    }
  }
  emitLiteral(256);
  return writer.finish();
}

function deflateStored(data: Uint8Array): number[] {
  const writer = new BitWriter();
  if (data.length === 0) {
    writer.bits(1, 1);
    writer.bits(0, 2);
    writer.alignToByte();
    writer.raw(Uint8Array.of(0, 0, 0xff, 0xff));
    return writer.finish();
  }
  for (let offset = 0; offset < data.length; offset += MAX_STORED_BLOCK) {
    const block = data.subarray(offset, Math.min(offset + MAX_STORED_BLOCK, data.length));
    writer.bits(offset + MAX_STORED_BLOCK >= data.length ? 1 : 0, 1);
    writer.bits(0, 2);
    writer.alignToByte();
    writer.raw(Uint8Array.of(block.length & 0xff, block.length >> 8, ~block.length & 0xff, (~block.length >> 8) & 0xff));
    writer.raw(block);
  }
  return writer.finish();
}

function zlibHeader(level: number): [number, number] {
  let flevel = 3;
  if (level < 2) flevel = 0;
  else if (level < 6) flevel = 1;
  else if (level === 6) flevel = 2;
  const cmf = 0x78;
  let flg = flevel << 6;
  const remainder = ((cmf << 8) + flg) % 31;
  if (remainder !== 0) flg += 31 - remainder;
  return [cmf, flg];
}

export function zlibCompress(data: Uint8Array, level: number): Uint8Array {
  const clamped = Math.max(0, Math.min(9, level));
  const body = clamped === 0 ? deflateStored(data) : (() => {
    const compressed = deflateFixed(data, clamped);
    const stored = deflateStored(data);
    return compressed.length <= stored.length ? compressed : stored;
  })();
  const [cmf, flg] = zlibHeader(clamped);
  const checksum = adler32(data);
  const output = new Uint8Array(2 + body.length + 4);
  output[0] = cmf;
  output[1] = flg;
  output.set(body, 2);
  const tail = 2 + body.length;
  output[tail] = checksum >>> 24;
  output[tail + 1] = (checksum >>> 16) & 0xff;
  output[tail + 2] = (checksum >>> 8) & 0xff;
  output[tail + 3] = checksum & 0xff;
  return output;
}

class BitReader {
  private position = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(private readonly bytes: Uint8Array, start: number) {
    this.position = start;
  }

  bits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.bytes.length) throw new ZlibError('unexpected end of deflate stream');
      this.bitBuffer |= this.bytes[this.position++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  takeBytes(count: number): Uint8Array {
    if (this.position + count > this.bytes.length) throw new ZlibError('unexpected end of deflate stream');
    const slice = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return slice;
  }

  get offset(): number {
    return this.position;
  }
}

interface HuffmanTable {
  readonly counts: number[];
  readonly symbols: number[];
}

function buildHuffman(lengths: number[]): HuffmanTable {
  const counts = new Array<number>(16).fill(0);
  for (const length of lengths) counts[length]++;
  counts[0] = 0;
  const offsets = new Array<number>(16).fill(0);
  for (let length = 1; length < 16; length++) offsets[length] = offsets[length - 1] + counts[length - 1];
  const symbols = new Array<number>(lengths.length).fill(0);
  lengths.forEach((length, symbol) => {
    if (length !== 0) symbols[offsets[length]++] = symbol;
  });
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length < 16; length++) {
    code |= reader.bits(1);
    const count = table.counts[length];
    if (code - count < first) return table.symbols[index + (code - first)];
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new ZlibError('invalid huffman code');
}

function fixedTables(): { literal: HuffmanTable; distance: HuffmanTable } {
  const lengths = new Array<number>(288).fill(8);
  for (let symbol = 144; symbol < 256; symbol++) lengths[symbol] = 9;
  for (let symbol = 256; symbol < 280; symbol++) lengths[symbol] = 7;
  return { literal: buildHuffman(lengths), distance: buildHuffman(new Array<number>(30).fill(5)) };
}

function dynamicTables(reader: BitReader): { literal: HuffmanTable; distance: HuffmanTable } {
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;
  const codeLengthLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeLengthCount; index++) codeLengthLengths[CODE_LENGTH_ORDER[index]] = reader.bits(3);
  const codeLengthTable = buildHuffman(codeLengthLengths);
  const lengths: number[] = [];
  while (lengths.length < literalCount + distanceCount) {
    const symbol = decodeSymbol(reader, codeLengthTable);
    if (symbol < 16) {
      lengths.push(symbol);
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      if (lengths.length === 0) throw new ZlibError('invalid repeat of previous code length');
      value = lengths[lengths.length - 1];
      repeat = 3 + reader.bits(2);
    } else if (symbol === 17) {
      repeat = 3 + reader.bits(3);
    } else {
      repeat = 11 + reader.bits(7);
    }
    for (let count = 0; count < repeat; count++) lengths.push(value);
  }
  return { literal: buildHuffman(lengths.slice(0, literalCount)), distance: buildHuffman(lengths.slice(literalCount)) };
}

export function zlibDecompress(data: Uint8Array, maxOutput = Number.MAX_SAFE_INTEGER): Uint8Array {
  if (data.length < 6) throw new ZlibError('zlib stream too short');
  if ((data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) throw new ZlibError('invalid zlib header');
  if ((data[1] & 0x20) !== 0) throw new ZlibError('preset dictionary not supported');
  const reader = new BitReader(data, 2);
  const output: number[] = [];
  let final = false;
  while (!final) {
    final = reader.bits(1) === 1;
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignToByte();
      const header = reader.takeBytes(4);
      const length = header[0] | (header[1] << 8);
      const complement = header[2] | (header[3] << 8);
      if ((length ^ 0xffff) !== complement) throw new ZlibError('stored block length mismatch');
      for (const byte of reader.takeBytes(length)) output.push(byte);
    } else if (type === 1 || type === 2) {
      const tables = type === 1 ? fixedTables() : dynamicTables(reader);
      for (;;) {
        const symbol = decodeSymbol(reader, tables.literal);
        if (symbol < 256) {
          output.push(symbol);
        } else if (symbol === 256) {
          break;
        } else {
          const lengthIndex = symbol - 257;
          if (lengthIndex >= LENGTH_BASE.length) throw new ZlibError('invalid length symbol');
          const length = LENGTH_BASE[lengthIndex] + reader.bits(LENGTH_EXTRA[lengthIndex]);
          const distanceIndex = decodeSymbol(reader, tables.distance);
          if (distanceIndex >= DISTANCE_BASE.length) throw new ZlibError('invalid distance symbol');
          const distance = DISTANCE_BASE[distanceIndex] + reader.bits(DISTANCE_EXTRA[distanceIndex]);
          if (distance > output.length) throw new ZlibError('distance too far back');
          for (let copied = 0; copied < length; copied++) output.push(output[output.length - distance]);
        }
        if (output.length > maxOutput) throw new ZlibError('inflated data exceeds limit');
      }
    } else {
      throw new ZlibError('invalid block type');
    }
  }
  const result = Uint8Array.from(output);
  const trailerAt = reader.offset;
  if (trailerAt + 4 > data.length) throw new ZlibError('missing adler32 trailer');
  const expected = ((data[trailerAt] << 24) | (data[trailerAt + 1] << 16) | (data[trailerAt + 2] << 8) | data[trailerAt + 3]) >>> 0;
  if (adler32(result) !== expected) throw new ZlibError('adler32 mismatch');
  return result;
}
