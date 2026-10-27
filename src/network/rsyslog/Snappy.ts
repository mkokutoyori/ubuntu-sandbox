const BLOCK_SIZE = 1 << 16;
const MAX_HASH_TABLE_BITS = 14;
const MAX_HASH_TABLE_SIZE = 1 << MAX_HASH_TABLE_BITS;
const MIN_HASH_TABLE_SIZE = 256;
const INPUT_MARGIN_BYTES = 15;
const HASH_MAGIC = 0x1e35a7bd;
const LITERAL = 0;
const COPY_1_BYTE_OFFSET = 1;
const COPY_2_BYTE_OFFSET = 2;
const COPY_4_BYTE_OFFSET = 3;
const MAX_UNCOMPRESSED_LENGTH = 0xffffffff;

export type SnappyResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false };

export function snappyMaxCompressedLength(sourceBytes: number): number {
  return 32 + sourceBytes + Math.floor(sourceBytes / 6);
}

function load32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function tableSizeFor(inputSize: number): number {
  if (inputSize > MAX_HASH_TABLE_SIZE) return MAX_HASH_TABLE_SIZE;
  if (inputSize < MIN_HASH_TABLE_SIZE) return MIN_HASH_TABLE_SIZE;
  return 2 << (31 - Math.clz32(inputSize - 1));
}

function tableIndex(bytes: number, mask: number): number {
  return (Math.imul(bytes, HASH_MAGIC) >>> (32 - MAX_HASH_TABLE_BITS)) & mask;
}

class Output {
  private bytes: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  push(value: number): void {
    this.bytes[this.length++] = value;
  }

  copyFrom(source: Uint8Array, start: number, count: number): void {
    this.bytes.set(source.subarray(start, start + count), this.length);
    this.length += count;
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function emitLiteral(out: Output, source: Uint8Array, start: number, length: number): void {
  const n = length - 1;
  if (n < 60) {
    out.push(LITERAL | (n << 2));
  } else {
    const lengthBytes: number[] = [];
    for (let remaining = n; remaining > 0; remaining >>>= 8) lengthBytes.push(remaining & 0xff);
    out.push(LITERAL | ((59 + lengthBytes.length) << 2));
    for (const byte of lengthBytes) out.push(byte);
  }
  out.copyFrom(source, start, length);
}

function emitCopyAtMost64(out: Output, offset: number, length: number): void {
  if (length < 12 && offset < 2048) {
    out.push(COPY_1_BYTE_OFFSET + ((length - 4) << 2) + ((offset >>> 8) << 5));
    out.push(offset & 0xff);
  } else {
    out.push(COPY_2_BYTE_OFFSET + ((length - 1) << 2));
    out.push(offset & 0xff);
    out.push((offset >>> 8) & 0xff);
  }
}

function emitCopy(out: Output, offset: number, length: number): void {
  let remaining = length;
  while (remaining >= 68) {
    emitCopyAtMost64(out, offset, 64);
    remaining -= 64;
  }
  if (remaining > 64) {
    emitCopyAtMost64(out, offset, 60);
    remaining -= 60;
  }
  emitCopyAtMost64(out, offset, remaining);
}

function matchLength(bytes: Uint8Array, left: number, right: number, limit: number): number {
  let matched = 0;
  while (right + matched < limit && bytes[left + matched] === bytes[right + matched]) matched++;
  return matched;
}

function compressFragment(source: Uint8Array, base: number, size: number, out: Output, table: Uint16Array, tableSize: number): void {
  const mask = tableSize - 1;
  const end = base + size;
  let ip = base;
  if (size >= INPUT_MARGIN_BYTES) {
    const limit = end - INPUT_MARGIN_BYTES;
    for (;;) {
      const nextEmit = ip++;
      let skip = 32;
      let candidate = 0;
      let matched = false;
      if (limit - ip >= 16) {
        const delta = ip - base;
        for (let index = 0; index < 16 && !matched; index++) {
          const dword = load32(source, ip + index);
          const slot = tableIndex(dword, mask);
          candidate = base + table[slot];
          table[slot] = delta + index;
          if (load32(source, candidate) === dword) {
            emitLiteral(out, source, nextEmit, ip + index - nextEmit);
            ip += index;
            matched = true;
          }
        }
        if (!matched) {
          ip += 16;
          skip += 16;
        }
      }
      if (!matched) {
        for (;;) {
          const data = load32(source, ip);
          const slot = tableIndex(data, mask);
          const step = skip >>> 5;
          skip += step;
          const nextIp = ip + step;
          if (nextIp > limit) {
            emitRemainder(out, source, nextEmit, end);
            return;
          }
          candidate = base + table[slot];
          table[slot] = ip - base;
          if (data === load32(source, candidate)) break;
          ip = nextIp;
        }
        emitLiteral(out, source, nextEmit, ip - nextEmit);
      }
      for (;;) {
        const origin = ip;
        const length = 4 + matchLength(source, candidate + 4, ip + 4, end);
        ip += length;
        emitCopy(out, origin - candidate, length);
        if (ip >= limit) {
          emitRemainder(out, source, ip, end);
          return;
        }
        table[tableIndex(load32(source, ip - 1), mask)] = ip - base - 1;
        const slot = tableIndex(load32(source, ip), mask);
        candidate = base + table[slot];
        table[slot] = ip - base;
        if (load32(source, ip) !== load32(source, candidate)) break;
      }
    }
  }
  emitRemainder(out, source, ip, end);
}

function emitRemainder(out: Output, source: Uint8Array, from: number, end: number): void {
  if (from < end) emitLiteral(out, source, from, end - from);
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

export function snappyCompress(source: Uint8Array): Uint8Array {
  const out = new Output(snappyMaxCompressedLength(source.length));
  for (const byte of varint(source.length)) out.push(byte);
  for (let start = 0; start < source.length; start += BLOCK_SIZE) {
    const size = Math.min(BLOCK_SIZE, source.length - start);
    const tableSize = tableSizeFor(size);
    compressFragment(source, start, size, out, new Uint16Array(tableSize), tableSize);
  }
  return out.result();
}

interface Preamble {
  readonly length: number;
  readonly next: number;
}

function readPreamble(input: Uint8Array): Preamble | null {
  let length = 0;
  let shift = 0;
  for (let index = 0; index < Math.min(5, input.length); index++) {
    const byte = input[index];
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return length > MAX_UNCOMPRESSED_LENGTH ? null : { length, next: index + 1 };
    shift += 7;
  }
  return null;
}

export function snappyUncompressedLength(input: Uint8Array): number | null {
  return readPreamble(input)?.length ?? null;
}

export function snappyUncompress(input: Uint8Array): SnappyResult {
  const preamble = readPreamble(input);
  if (preamble === null) return { ok: false };
  const output = new Uint8Array(preamble.length);
  let produced = 0;
  let index = preamble.next;
  while (index < input.length) {
    const tag = input[index++];
    const kind = tag & 3;
    if (kind === LITERAL) {
      let length = tag >>> 2;
      if (length >= 60) {
        const lengthBytes = length - 59;
        if (index + lengthBytes > input.length) return { ok: false };
        length = 0;
        for (let byte = 0; byte < lengthBytes; byte++) length += input[index + byte] * 2 ** (8 * byte);
        index += lengthBytes;
      }
      length += 1;
      if (index + length > input.length || produced + length > output.length) return { ok: false };
      output.set(input.subarray(index, index + length), produced);
      index += length;
      produced += length;
      continue;
    }
    let length: number;
    let offset: number;
    if (kind === COPY_1_BYTE_OFFSET) {
      if (index + 1 > input.length) return { ok: false };
      length = 4 + ((tag >>> 2) & 7);
      offset = ((tag >>> 5) << 8) | input[index];
      index += 1;
    } else if (kind === COPY_2_BYTE_OFFSET) {
      if (index + 2 > input.length) return { ok: false };
      length = 1 + (tag >>> 2);
      offset = input[index] | (input[index + 1] << 8);
      index += 2;
    } else {
      if (index + 4 > input.length) return { ok: false };
      length = 1 + (tag >>> 2);
      offset = load32(input, index);
      index += 4;
    }
    if (offset === 0 || offset > produced || produced + length > output.length) return { ok: false };
    for (let copied = 0; copied < length; copied++) output[produced + copied] = output[produced + copied - offset];
    produced += length;
  }
  return produced === output.length ? { ok: true, bytes: output } : { ok: false };
}
