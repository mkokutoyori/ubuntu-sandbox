// RFC 7541 — HPACK header compression. Literal string encoding only (no
// Huffman bit-exact codec, cf. PRD-HTTP.md §2.2); the static table and the
// dynamic table's indexing/eviction logic are real.
export interface HpackEntry {
  name: string;
  value: string;
}

// RFC 7541 Appendix A — the 61-entry static table, 1-indexed.
export const STATIC_TABLE: HpackEntry[] = [
  { name: ':authority', value: '' },
  { name: ':method', value: 'GET' },
  { name: ':method', value: 'POST' },
  { name: ':path', value: '/' },
  { name: ':path', value: '/index.html' },
  { name: ':scheme', value: 'http' },
  { name: ':scheme', value: 'https' },
  { name: ':status', value: '200' },
  { name: ':status', value: '204' },
  { name: ':status', value: '206' },
  { name: ':status', value: '304' },
  { name: ':status', value: '400' },
  { name: ':status', value: '404' },
  { name: ':status', value: '500' },
  { name: 'accept-charset', value: '' },
  { name: 'accept-encoding', value: 'gzip, deflate' },
  { name: 'accept-language', value: '' },
  { name: 'accept-ranges', value: '' },
  { name: 'accept', value: '' },
  { name: 'access-control-allow-origin', value: '' },
  { name: 'age', value: '' },
  { name: 'allow', value: '' },
  { name: 'authorization', value: '' },
  { name: 'cache-control', value: '' },
  { name: 'content-disposition', value: '' },
  { name: 'content-encoding', value: '' },
  { name: 'content-language', value: '' },
  { name: 'content-length', value: '' },
  { name: 'content-location', value: '' },
  { name: 'content-range', value: '' },
  { name: 'content-type', value: '' },
  { name: 'cookie', value: '' },
  { name: 'date', value: '' },
  { name: 'etag', value: '' },
  { name: 'expect', value: '' },
  { name: 'expires', value: '' },
  { name: 'from', value: '' },
  { name: 'host', value: '' },
  { name: 'if-match', value: '' },
  { name: 'if-modified-since', value: '' },
  { name: 'if-none-match', value: '' },
  { name: 'if-range', value: '' },
  { name: 'if-unmodified-since', value: '' },
  { name: 'last-modified', value: '' },
  { name: 'link', value: '' },
  { name: 'location', value: '' },
  { name: 'max-forwards', value: '' },
  { name: 'proxy-authenticate', value: '' },
  { name: 'proxy-authorization', value: '' },
  { name: 'range', value: '' },
  { name: 'referer', value: '' },
  { name: 'refresh', value: '' },
  { name: 'retry-after', value: '' },
  { name: 'server', value: '' },
  { name: 'set-cookie', value: '' },
  { name: 'strict-transport-security', value: '' },
  { name: 'transfer-encoding', value: '' },
  { name: 'user-agent', value: '' },
  { name: 'vary', value: '' },
  { name: 'via', value: '' },
  { name: 'www-authenticate', value: '' },
];

const DEFAULT_DYNAMIC_TABLE_SIZE = 4096;

// RFC 7541 §4.1 — an entry's size accounts for a fixed 32-byte overhead.
function entrySize(e: HpackEntry): number {
  return e.name.length + e.value.length + 32;
}

export class HpackDynamicTable {
  private entries: HpackEntry[] = [];
  private maxSize = DEFAULT_DYNAMIC_TABLE_SIZE;
  private currentSize = 0;

  setMaxSize(size: number): void {
    this.maxSize = size;
    this.evictToFit();
  }

  add(entry: HpackEntry): void {
    this.entries.unshift(entry);
    this.currentSize += entrySize(entry);
    this.evictToFit();
  }

  private evictToFit(): void {
    while (this.currentSize > this.maxSize && this.entries.length > 0) {
      const removed = this.entries.pop()!;
      this.currentSize -= entrySize(removed);
    }
  }

  get(indexFromZero: number): HpackEntry | undefined {
    return this.entries[indexFromZero];
  }

  get length(): number {
    return this.entries.length;
  }

  get size(): number {
    return this.currentSize;
  }
}

interface IndexLookup {
  index: number;
  nameOnly: boolean;
}

/** Per-direction HPACK state (RFC 7541 §2.2 — encoder and decoder each keep their own dynamic table). */
export class HpackContext {
  readonly dynamicTable = new HpackDynamicTable();

  lookup(index: number): HpackEntry | undefined {
    if (index >= 1 && index <= STATIC_TABLE.length) return STATIC_TABLE[index - 1];
    return this.dynamicTable.get(index - STATIC_TABLE.length - 1);
  }

  findIndex(name: string, value: string): IndexLookup | null {
    for (let i = 0; i < STATIC_TABLE.length; i++) {
      if (STATIC_TABLE[i].name === name && STATIC_TABLE[i].value === value) return { index: i + 1, nameOnly: false };
    }
    for (let i = 0; i < this.dynamicTable.length; i++) {
      const e = this.dynamicTable.get(i)!;
      if (e.name === name && e.value === value) return { index: STATIC_TABLE.length + 1 + i, nameOnly: false };
    }
    for (let i = 0; i < STATIC_TABLE.length; i++) {
      if (STATIC_TABLE[i].name === name) return { index: i + 1, nameOnly: true };
    }
    for (let i = 0; i < this.dynamicTable.length; i++) {
      if (this.dynamicTable.get(i)!.name === name) return { index: STATIC_TABLE.length + 1 + i, nameOnly: true };
    }
    return null;
  }
}

// RFC 7541 §5.1 — N-bit prefix integer representation.
export function encodeInteger(value: number, prefixBits: number, prefixValue: number): number[] {
  const max = (1 << prefixBits) - 1;
  if (value < max) return [prefixValue | value];
  const bytes = [prefixValue | max];
  let remaining = value - max;
  while (remaining >= 128) {
    bytes.push((remaining % 128) + 128);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

export function decodeInteger(bytes: Uint8Array, offset: number, prefixBits: number): { value: number; bytesConsumed: number } {
  const max = (1 << prefixBits) - 1;
  let value = bytes[offset] & max;
  let consumed = 1;
  if (value === max) {
    let m = 0;
    let b: number;
    do {
      b = bytes[offset + consumed];
      value += (b & 0x7f) * 2 ** m;
      m += 7;
      consumed++;
    } while (b & 0x80);
  }
  return { value, bytesConsumed: consumed };
}

// RFC 7541 §5.2 — string literal, H bit always 0 here (no Huffman).
export function encodeString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...encodeInteger(bytes.length, 7, 0x00), ...bytes];
}

export function decodeString(bytes: Uint8Array, offset: number): { value: string; bytesConsumed: number } | null {
  const huffman = (bytes[offset] & 0x80) !== 0;
  if (huffman) return null;
  const lenResult = decodeInteger(bytes, offset, 7);
  const start = offset + lenResult.bytesConsumed;
  const strBytes = bytes.slice(start, start + lenResult.value);
  return { value: new TextDecoder().decode(strBytes), bytesConsumed: lenResult.bytesConsumed + lenResult.value };
}

export type HpackIndexing = 'incremental' | 'without' | 'never';

// RFC 7541 §6.1/§6.2 — encodes one header field representation.
export function encodeHeaderField(ctx: HpackContext, name: string, value: string, indexing: HpackIndexing = 'incremental'): number[] {
  const found = ctx.findIndex(name, value);
  if (found && !found.nameOnly) {
    return encodeInteger(found.index, 7, 0x80);
  }

  const prefixBits = indexing === 'incremental' ? 6 : 4;
  const prefixValue = indexing === 'incremental' ? 0x40 : indexing === 'never' ? 0x10 : 0x00;
  const nameIndex = found?.nameOnly ? found.index : 0;

  const head = encodeInteger(nameIndex, prefixBits, prefixValue);
  const nameBytes = nameIndex === 0 ? encodeString(name) : [];
  const valueBytes = encodeString(value);

  if (indexing === 'incremental') ctx.dynamicTable.add({ name, value });
  return [...head, ...nameBytes, ...valueBytes];
}

export function encodeHeaderBlock(ctx: HpackContext, headers: [string, string][], indexing: HpackIndexing = 'incremental'): Uint8Array {
  const bytes: number[] = [];
  for (const [name, value] of headers) bytes.push(...encodeHeaderField(ctx, name, value, indexing));
  return new Uint8Array(bytes);
}

export type DecodedHeaderField =
  | { kind: 'header'; name: string; value: string; bytesConsumed: number }
  | { kind: 'sizeUpdate'; bytesConsumed: number };

export function decodeHeaderField(ctx: HpackContext, bytes: Uint8Array, offset: number): DecodedHeaderField | null {
  const first = bytes[offset];

  if (first & 0x80) {
    const { value: index, bytesConsumed } = decodeInteger(bytes, offset, 7);
    const entry = ctx.lookup(index);
    if (!entry) return null;
    return { kind: 'header', name: entry.name, value: entry.value, bytesConsumed };
  }

  if (first & 0x20) {
    const { value: newSize, bytesConsumed } = decodeInteger(bytes, offset, 5);
    ctx.dynamicTable.setMaxSize(newSize);
    return { kind: 'sizeUpdate', bytesConsumed };
  }

  const incremental = (first & 0x40) !== 0;
  const never = !incremental && (first & 0x10) !== 0;
  const prefixBits = incremental ? 6 : 4;
  const indexing: HpackIndexing = incremental ? 'incremental' : never ? 'never' : 'without';

  const idxResult = decodeInteger(bytes, offset, prefixBits);
  let off = offset + idxResult.bytesConsumed;
  let name: string;
  if (idxResult.value === 0) {
    const nameResult = decodeString(bytes, off);
    if (!nameResult) return null;
    name = nameResult.value;
    off += nameResult.bytesConsumed;
  } else {
    const entry = ctx.lookup(idxResult.value);
    if (!entry) return null;
    name = entry.name;
  }

  const valueResult = decodeString(bytes, off);
  if (!valueResult) return null;
  off += valueResult.bytesConsumed;

  if (indexing === 'incremental') ctx.dynamicTable.add({ name, value: valueResult.value });
  return { kind: 'header', name, value: valueResult.value, bytesConsumed: off - offset };
}

export function decodeHeaderBlock(ctx: HpackContext, bytes: Uint8Array): [string, string][] {
  const headers: [string, string][] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const decoded = decodeHeaderField(ctx, bytes, offset);
    if (!decoded) throw new Error('Malformed HPACK header block');
    if (decoded.kind === 'header') headers.push([decoded.name, decoded.value]);
    offset += decoded.bytesConsumed;
  }
  return headers;
}
