import { crc32 } from '@/network/rsyslog/Zlib';
import { sha256 } from '@/crypto/hash/sha256';
import { LzmaDecoder, LzmaError, parseLzmaProperties } from './LzmaDecoder';

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a];
const FILTER_LZMA2 = 0x21;
const CHECK_NONE = 0;
const CHECK_CRC32 = 1;
const CHECK_CRC64 = 4;
const CHECK_SHA256 = 10;
const CRC64_POLYNOMIAL = 0xc96c5795d7870f42n;
const CRC64_MASK = 0xffffffffffffffffn;

export type XzResult = { readonly ok: true; readonly bytes: Uint8Array; readonly reason?: undefined } | { readonly ok: false; readonly reason: string; readonly bytes?: undefined };

const CRC64_TABLE = (() => {
  const table: bigint[] = [];
  for (let index = 0; index < 256; index++) {
    let value = BigInt(index);
    for (let bit = 0; bit < 8; bit++) value = (value & 1n) === 1n ? CRC64_POLYNOMIAL ^ (value >> 1n) : value >> 1n;
    table.push(value);
  }
  return table;
})();

export function crc64(bytes: Uint8Array): bigint {
  let value = CRC64_MASK;
  for (const byte of bytes) value = CRC64_TABLE[Number((value ^ BigInt(byte)) & 0xffn)] ^ (value >> 8n);
  return value ^ CRC64_MASK;
}

class Reader {
  position = 0;

  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.position >= this.bytes.length) throw new LzmaError('truncated');
    return this.bytes[this.position++];
  }

  take(count: number): Uint8Array {
    if (this.position + count > this.bytes.length) throw new LzmaError('truncated');
    const out = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return out;
  }

  varint(): bigint {
    let value = 0n;
    for (let index = 0; index < 9; index++) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        if (byte === 0 && index > 0) throw new LzmaError('non-minimal varint');
        return value;
      }
    }
    throw new LzmaError('varint too long');
  }
}

function littleEndian(bytes: Uint8Array): number {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

function checkSize(type: number): number {
  switch (type) {
    case CHECK_NONE: return 0;
    case CHECK_CRC32: return 4;
    case CHECK_CRC64: return 8;
    case CHECK_SHA256: return 32;
    default: throw new LzmaError('check type');
  }
}

function verifyCheck(type: number, data: Uint8Array, stored: Uint8Array): void {
  let expected: Uint8Array;
  if (type === CHECK_NONE) return;
  if (type === CHECK_CRC32) {
    const value = crc32(data);
    expected = Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  } else if (type === CHECK_CRC64) {
    const value = crc64(data);
    expected = Uint8Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(8 * index)) & 0xffn));
  } else expected = sha256(data);
  if (expected.some((byte, index) => byte !== stored[index])) throw new LzmaError('check mismatch');
}

function decodeLzma2(reader: Reader, end: number): Uint8Array {
  const decoder = new LzmaDecoder();
  const output: number[] = [];
  let dictStart = 0;
  let needDictReset = true;
  let needProperties = true;
  for (;;) {
    const control = reader.byte();
    if (control === 0) break;
    if (control < 0x80) {
      if (control > 2) throw new LzmaError('LZMA2 control');
      if (control === 1) {
        dictStart = output.length;
        needDictReset = false;
      } else if (needDictReset) throw new LzmaError('missing dictionary reset');
      const size = ((reader.byte() << 8) | reader.byte()) + 1;
      for (const byte of reader.take(size)) output.push(byte);
      continue;
    }
    const unpacked = (((control & 0x1f) << 16) | (reader.byte() << 8) | reader.byte()) + 1;
    const packed = ((reader.byte() << 8) | reader.byte()) + 1;
    const reset = (control >>> 5) & 3;
    if (reset === 3) {
      dictStart = output.length;
      needDictReset = false;
    } else if (needDictReset) throw new LzmaError('missing dictionary reset');
    if (reset >= 2) {
      decoder.setProperties(parseLzmaProperties(reader.byte()));
      needProperties = false;
    } else if (needProperties) throw new LzmaError('missing properties');
    if (reset >= 1) decoder.resetState();
    if (reader.position + packed > end) throw new LzmaError('chunk past the block');
    decoder.decodeChunk(reader.bytes, reader.position, reader.position + packed, output, dictStart, unpacked);
    reader.position += packed;
  }
  return Uint8Array.from(output);
}

interface BlockRecord {
  readonly unpaddedSize: bigint;
  readonly uncompressedSize: bigint;
}

function decodeBlock(reader: Reader, checkType: number): { data: Uint8Array; record: BlockRecord } {
  const start = reader.position;
  const headerSize = (reader.byte() + 1) * 4;
  const header = reader.bytes.subarray(start, start + headerSize);
  if (header.length !== headerSize) throw new LzmaError('truncated block header');
  reader.position = start + headerSize;
  if (littleEndian(header.subarray(headerSize - 4)) !== crc32(header.subarray(0, headerSize - 4))) throw new LzmaError('block header CRC');
  const inner = new Reader(header.subarray(0, headerSize - 4));
  inner.position = 1;
  const flags = inner.byte();
  if ((flags & 0x3c) !== 0) throw new LzmaError('block flags');
  const filters = (flags & 3) + 1;
  const declaredCompressed = (flags & 0x40) !== 0 ? inner.varint() : null;
  const declaredUncompressed = (flags & 0x80) !== 0 ? inner.varint() : null;
  if (filters !== 1) throw new LzmaError('filter chain');
  if (inner.varint() !== BigInt(FILTER_LZMA2)) throw new LzmaError('filter id');
  if (inner.varint() !== 1n) throw new LzmaError('filter properties');
  if (inner.byte() > 40) throw new LzmaError('dictionary size');
  while (inner.position < inner.bytes.length) if (inner.byte() !== 0) throw new LzmaError('header padding');
  const dataStart = reader.position;
  const data = decodeLzma2(reader, reader.bytes.length);
  const compressedSize = reader.position - dataStart;
  if (declaredCompressed !== null && declaredCompressed !== BigInt(compressedSize)) throw new LzmaError('compressed size');
  if (declaredUncompressed !== null && declaredUncompressed !== BigInt(data.length)) throw new LzmaError('uncompressed size');
  const padding = (4 - (compressedSize % 4)) % 4;
  for (const byte of reader.take(padding)) if (byte !== 0) throw new LzmaError('block padding');
  verifyCheck(checkType, data, reader.take(checkSize(checkType)));
  return { data, record: { unpaddedSize: BigInt(headerSize + compressedSize + checkSize(checkType)), uncompressedSize: BigInt(data.length) } };
}

function verifyIndex(reader: Reader, records: readonly BlockRecord[]): number {
  const start = reader.position;
  if (reader.byte() !== 0) throw new LzmaError('index indicator');
  if (reader.varint() !== BigInt(records.length)) throw new LzmaError('index record count');
  for (const record of records) {
    if (reader.varint() !== record.unpaddedSize || reader.varint() !== record.uncompressedSize) throw new LzmaError('index record');
  }
  while ((reader.position - start) % 4 !== 0) if (reader.byte() !== 0) throw new LzmaError('index padding');
  const size = reader.position - start;
  if (littleEndian(reader.take(4)) !== crc32(reader.bytes.subarray(start, reader.position - 4))) throw new LzmaError('index CRC');
  return size + 4;
}

export function xzDecompress(source: Uint8Array): XzResult {
  try {
    const reader = new Reader(source);
    const header = reader.take(12);
    if (MAGIC.some((byte, index) => header[index] !== byte)) throw new LzmaError('magic');
    if (header[6] !== 0 || (header[7] & 0xf0) !== 0) throw new LzmaError('stream flags');
    if (littleEndian(header.subarray(8)) !== crc32(header.subarray(6, 8))) throw new LzmaError('stream header CRC');
    const checkType = header[7] & 0x0f;
    checkSize(checkType);
    const chunks: Uint8Array[] = [];
    const records: BlockRecord[] = [];
    while (reader.bytes[reader.position] !== 0) {
      const block = decodeBlock(reader, checkType);
      chunks.push(block.data);
      records.push(block.record);
    }
    const indexSize = verifyIndex(reader, records);
    const footer = reader.take(12);
    if (littleEndian(footer.subarray(0, 4)) !== crc32(footer.subarray(4, 10))) throw new LzmaError('footer CRC');
    if ((littleEndian(footer.subarray(4, 8)) + 1) * 4 !== indexSize) throw new LzmaError('backward size');
    if (footer[8] !== header[6] || footer[9] !== header[7]) throw new LzmaError('footer flags');
    if (footer[10] !== FOOTER_MAGIC[0] || footer[11] !== FOOTER_MAGIC[1]) throw new LzmaError('footer magic');
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { ok: true, bytes };
  } catch (error) {
    if (error instanceof LzmaError) return { ok: false, reason: error.message };
    throw error;
  }
}
