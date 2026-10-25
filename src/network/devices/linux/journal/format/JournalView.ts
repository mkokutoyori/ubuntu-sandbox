import { sipHash24 } from '@/network/rsyslog/SipHash';
import type { Errno } from '@/network/core/Errno';
import { lz4DecompressBlock } from '@/network/compression/lz4/Lz4Block';
import { zstdDecompress } from '@/network/compression/zstd/ZstdDecoder';
import { jenkinsHash64 } from './JenkinsHash';
import {
  COMPATIBLE_SEALED, COMPATIBLE_SEALED_CONTINUOUS, COMPATIBLE_TAIL_ENTRY_BOOT_ID, DATA, ENTRY, ENTRY_ARRAY, HEADER, HEADER_SIZE, INCOMPATIBLE_COMPACT,
  INCOMPATIBLE_COMPRESSED_LZ4, INCOMPATIBLE_COMPRESSED_XZ, INCOMPATIBLE_COMPRESSED_ZSTD, INCOMPATIBLE_KEYED_HASH, OBJECT_DATA, OBJECT_DATA_HASH_TABLE, OBJECT_ENTRY,
  OBJECT_ENTRY_ARRAY, OBJECT_FIELD, OBJECT_FIELD_HASH_TABLE, OBJECT_TAG, OBJECT_UNUSED, SIGNATURE,
} from './JournalLayout';

export const U64_MAX = (1n << 64n) - 1n;
const HEADER_SIZE_MIN = 208n;
const OBJECT_COMPRESSED_LZ4 = 2;
const OBJECT_COMPRESSED_ZSTD = 4;
const OBJECT_COMPRESSED_MASK = 7;
const STATE_MAX = 3;
const TAG_OBJECT_BYTES = 64n;
const MAX_EPOCH = 1n << 55n;
const INCOMPATIBLE_SUPPORTED = INCOMPATIBLE_COMPRESSED_XZ | INCOMPATIBLE_COMPRESSED_LZ4 | INCOMPATIBLE_COMPRESSED_ZSTD | INCOMPATIBLE_KEYED_HASH | INCOMPATIBLE_COMPACT;

export const valid64 = (value: bigint): boolean => (value & 7n) === 0n;
export const align64 = (value: bigint): bigint => (value + 7n) & ~7n;
export const validRealtime = (value: bigint): boolean => value > 0n && value < 1n << 55n;
export const validMonotonic = (value: bigint): boolean => value < 1n << 55n;
export const validEpoch = (value: bigint): boolean => value < MAX_EPOCH;

export type MoveResult = { readonly ok: true; readonly offset: number; readonly errno?: undefined } | { readonly ok: false; readonly errno: Errno; readonly offset?: undefined };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

export class JournalView {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  get size(): number {
    return this.bytes.length;
  }

  u8(offset: number): number {
    return offset >= 0 && offset < this.bytes.length ? this.bytes[offset] : 0;
  }

  u32(offset: number): number {
    return offset >= 0 && offset + 4 <= this.bytes.length ? this.view.getUint32(offset, true) : 0;
  }

  u64(offset: number): bigint {
    return offset >= 0 && offset + 8 <= this.bytes.length ? this.view.getBigUint64(offset, true) : 0n;
  }

  lowHigh(offset: number): number {
    return offset >= 0 && offset + 8 <= this.bytes.length ? this.view.getUint32(offset, true) | this.view.getUint32(offset + 4, true) : 0;
  }

  slice(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(Math.max(0, offset), Math.max(0, Math.min(this.bytes.length, offset + length)));
  }

  get compatibleFlags(): number {
    return this.u32(HEADER.compatibleFlags);
  }

  get incompatibleFlags(): number {
    return this.u32(HEADER.incompatibleFlags);
  }

  get sealed(): boolean {
    return (this.compatibleFlags & COMPATIBLE_SEALED) !== 0;
  }

  get sealedContinuous(): boolean {
    return (this.compatibleFlags & COMPATIBLE_SEALED_CONTINUOUS) !== 0;
  }

  get tailEntryBootIdFlag(): boolean {
    return (this.compatibleFlags & COMPATIBLE_TAIL_ENTRY_BOOT_ID) !== 0;
  }

  get compact(): boolean {
    return (this.incompatibleFlags & INCOMPATIBLE_COMPACT) !== 0;
  }

  get keyedHash(): boolean {
    return (this.incompatibleFlags & INCOMPATIBLE_KEYED_HASH) !== 0;
  }

  header(field: number): bigint {
    return this.u64(field);
  }

  headerContains(field: number, width: number): boolean {
    return this.header(HEADER.headerSize) >= BigInt(field + width);
  }

  get entryItemSize(): number {
    return this.compact ? 4 : 16;
  }

  get entryArrayItemSize(): number {
    return this.compact ? 4 : 8;
  }

  get dataPayloadOffset(): number {
    return this.compact ? DATA.payload : 64;
  }

  objectType(offset: number): number {
    return this.u8(offset);
  }

  objectFlags(offset: number): number {
    return this.u8(offset + 1);
  }

  objectSize(offset: number): bigint {
    return this.u64(offset + 8);
  }

  entryItemCount(offset: number): bigint {
    if (this.objectType(offset) !== OBJECT_ENTRY) return 0n;
    const size = this.objectSize(offset);
    if (size < BigInt(ENTRY.items)) return 0n;
    return (size - BigInt(ENTRY.items)) / BigInt(this.entryItemSize);
  }

  entryItemOffset(entry: number, index: number): bigint {
    const at = entry + ENTRY.items + index * this.entryItemSize;
    return this.compact ? BigInt(this.u32(at)) : this.u64(at);
  }

  entryArrayItemCount(offset: number): bigint {
    if (this.objectType(offset) !== OBJECT_ENTRY_ARRAY) return 0n;
    const size = this.objectSize(offset);
    if (size < BigInt(ENTRY_ARRAY.items)) return 0n;
    return (size - BigInt(ENTRY_ARRAY.items)) / BigInt(this.entryArrayItemSize);
  }

  entryArrayItem(array: number, index: number): bigint {
    const at = array + ENTRY_ARRAY.items + index * this.entryArrayItemSize;
    return this.compact ? BigInt(this.u32(at)) : this.u64(at);
  }

  hashTableItemCount(offset: number): bigint {
    const type = this.objectType(offset);
    if (type !== OBJECT_DATA_HASH_TABLE && type !== OBJECT_FIELD_HASH_TABLE) return 0n;
    const size = this.objectSize(offset);
    return size < 16n ? 0n : (size - 16n) / 16n;
  }

  hashData(bytes: Uint8Array): bigint {
    if (!this.keyedHash) return jenkinsHash64(bytes);
    const digest = sipHash24(bytes, this.bytes.subarray(HEADER.fileId, HEADER.fileId + 16));
    let value = 0n;
    for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(digest[index]);
    return value;
  }

  decompress(flags: number, stored: Uint8Array): { readonly ok: true; readonly bytes: Uint8Array; readonly errno?: undefined } | { readonly ok: false; readonly errno: Errno; readonly bytes?: undefined } {
    const compression = flags & OBJECT_COMPRESSED_MASK;
    if (compression === 0) return { ok: true, bytes: stored };
    if (compression === OBJECT_COMPRESSED_ZSTD) {
      const result = zstdDecompress(stored);
      return result.ok ? { ok: true, bytes: result.bytes } : { ok: false, errno: 'EBADMSG' };
    }
    if (compression === OBJECT_COMPRESSED_LZ4) return this.decompressLz4(stored);
    return { ok: false, errno: 'ENOMEM' };
  }

  private decompressLz4(stored: Uint8Array): { readonly ok: true; readonly bytes: Uint8Array; readonly errno?: undefined } | { readonly ok: false; readonly errno: Errno; readonly bytes?: undefined } {
    if (stored.length <= 8) return { ok: false, errno: 'ENODATA' };
    const size = new DataView(stored.buffer, stored.byteOffset, stored.length).getBigUint64(0, true);
    if (size > 0x7fffffffn) return { ok: false, errno: 'EFBIG' };
    if (size > BigInt(stored.length) * 255n) return { ok: false, errno: 'EBADMSG' };
    const bytes = lz4DecompressBlock(stored.subarray(8), Number(size));
    return bytes === null ? { ok: false, errno: 'EBADMSG' } : { ok: true, bytes };
  }

  private moveTo(offset: bigint, size: bigint): Errno | null {
    if (size <= 0n) return 'EINVAL';
    if (size > U64_MAX - offset) return 'EBADMSG';
    if (offset + size > BigInt(this.bytes.length)) return 'EADDRNOTAVAIL';
    return null;
  }

  private minimumHeaderSize(offset: number): bigint {
    switch (this.objectType(offset)) {
      case OBJECT_DATA: return BigInt(this.dataPayloadOffset);
      case OBJECT_FIELD: return 40n;
      case OBJECT_ENTRY: return 64n;
      case OBJECT_DATA_HASH_TABLE:
      case OBJECT_FIELD_HASH_TABLE: return 16n;
      case OBJECT_ENTRY_ARRAY: return 24n;
      case OBJECT_TAG: return TAG_OBJECT_BYTES;
      default: return 16n;
    }
  }

  private checkObjectHeader(type: number, offset: number): Errno | null {
    const size = this.objectSize(offset);
    if (size === 0n) return 'EBADMSG';
    if (size < 16n) return 'EBADMSG';
    const actual = this.objectType(offset);
    if (actual <= OBJECT_UNUSED || actual > OBJECT_TAG) return 'EBADMSG';
    if (type > OBJECT_UNUSED && actual !== type) return 'EBADMSG';
    if (size < this.minimumHeaderSize(offset)) return 'EBADMSG';
    return null;
  }

  private checkObject(offset: number): Errno | null {
    const size = this.objectSize(offset);
    switch (this.objectType(offset)) {
      case OBJECT_DATA:
        if ((this.u64(offset + DATA.entryOffset) === 0n) !== (this.u64(offset + DATA.nEntries) === 0n)) return 'EBADMSG';
        if (size <= BigInt(this.dataPayloadOffset)) return 'EBADMSG';
        if (![DATA.nextHashOffset, DATA.nextFieldOffset, DATA.entryOffset, DATA.entryArrayOffset].every((field) => valid64(this.u64(offset + field)))) return 'EBADMSG';
        break;
      case OBJECT_FIELD:
        if (size <= 40n) return 'EBADMSG';
        if (!valid64(this.u64(offset + 24)) || !valid64(this.u64(offset + 32))) return 'EBADMSG';
        break;
      case OBJECT_ENTRY: {
        if (size < 64n || (size - 64n) % BigInt(this.entryItemSize) !== 0n) return 'EBADMSG';
        if ((size - 64n) / BigInt(this.entryItemSize) <= 0n) return 'EBADMSG';
        if (this.u64(offset + ENTRY.seqnum) <= 0n) return 'EBADMSG';
        if (!validRealtime(this.u64(offset + ENTRY.realtime))) return 'EBADMSG';
        if (!validMonotonic(this.u64(offset + ENTRY.monotonic))) return 'EBADMSG';
        if (this.slice(offset + ENTRY.bootId, 16).every((byte) => byte === 0)) return 'EBADMSG';
        break;
      }
      case OBJECT_DATA_HASH_TABLE:
      case OBJECT_FIELD_HASH_TABLE:
        if (size < 16n || (size - 16n) % 16n !== 0n || (size - 16n) / 16n <= 0n) return 'EBADMSG';
        break;
      case OBJECT_ENTRY_ARRAY: {
        if (size < 24n || (size - 24n) % BigInt(this.entryArrayItemSize) !== 0n || (size - 24n) / BigInt(this.entryArrayItemSize) <= 0n) return 'EBADMSG';
        const next = this.u64(offset + ENTRY_ARRAY.nextEntryArrayOffset);
        if (!valid64(next) || (next > 0n && next <= BigInt(offset))) return 'EBADMSG';
        break;
      }
      case OBJECT_TAG:
        if (size !== TAG_OBJECT_BYTES) return 'EBADMSG';
        if (!validEpoch(this.u64(offset + 24))) return 'EBADMSG';
        break;
      default:
        break;
    }
    return null;
  }

  moveToObject(type: number, offset: bigint): MoveResult {
    if (!valid64(offset)) return { ok: false, errno: 'EBADMSG' };
    if (offset < this.header(HEADER.headerSize)) return { ok: false, errno: 'EBADMSG' };
    const first = this.moveTo(offset, 16n);
    if (first !== null) return { ok: false, errno: first };
    const at = Number(offset);
    const initial = this.checkObjectHeader(type, at);
    if (initial !== null) return { ok: false, errno: initial };
    const second = this.moveTo(offset, this.objectSize(at));
    if (second !== null) return { ok: false, errno: second };
    const again = this.checkObjectHeader(type, at);
    if (again !== null) return { ok: false, errno: again };
    const content = this.checkObject(at);
    if (content !== null) return { ok: false, errno: content };
    return { ok: true, offset: at };
  }

  moveToRegion(offset: bigint, size: bigint): Errno | null {
    return this.moveTo(offset, size);
  }

  samePayload(offset: number, payload: Uint8Array): boolean {
    const stored = this.slice(offset + this.dataPayloadOffset, Number(this.objectSize(offset)) - this.dataPayloadOffset);
    const result = this.decompress(this.objectFlags(offset), stored);
    return result.ok && sameBytes(result.bytes, payload);
  }
}

function offsetIsValid(offset: bigint, headerSize: bigint, tailObjectOffset: bigint): boolean {
  if (offset === 0n) return true;
  if (!valid64(offset)) return false;
  if (offset < headerSize) return false;
  if (offset > tailObjectOffset) return false;
  return true;
}

function hashTableIsValid(offset: bigint, size: bigint, headerSize: bigint, arenaSize: bigint, tailObjectOffset: bigint): boolean {
  if ((offset === 0n) !== (size === 0n)) return false;
  if (offset === 0n) return true;
  if (offset <= 16n) return false;
  const start = offset - 16n;
  if (!offsetIsValid(start, headerSize, tailObjectOffset)) return false;
  return size <= headerSize + arenaSize - start;
}

export type OpenResult = { readonly ok: true; readonly journal: JournalView; readonly errno?: undefined } | { readonly ok: false; readonly errno: Errno; readonly journal?: undefined };

export function openJournal(bytes: Uint8Array): OpenResult {
  const journal = new JournalView(bytes);
  const fail = (errno: Errno): OpenResult => ({ ok: false, errno });
  if (BigInt(bytes.length) < HEADER_SIZE_MIN) return fail('ENODATA');
  const signature = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (signature !== SIGNATURE) return fail('EBADMSG');
  if ((journal.incompatibleFlags & ~INCOMPATIBLE_SUPPORTED) !== 0) return fail('EPROTONOSUPPORT');
  if (journal.u8(HEADER.state) >= STATE_MAX) return fail('EBADMSG');
  const headerSize = journal.header(HEADER.headerSize);
  if (headerSize < HEADER_SIZE_MIN) return fail('EBADMSG');
  if (journal.sealed && !journal.headerContains(HEADER.nEntryArrays, 8)) return fail('EBADMSG');
  const arenaSize = journal.header(HEADER.arenaSize);
  if (U64_MAX - headerSize < arenaSize || headerSize + arenaSize > BigInt(bytes.length)) return fail('ENODATA');
  const tailObjectOffset = journal.header(HEADER.tailObjectOffset);
  if (!offsetIsValid(tailObjectOffset, headerSize, U64_MAX)) return fail('ENODATA');
  if (headerSize + arenaSize < tailObjectOffset) return fail('ENODATA');
  if (headerSize + arenaSize - tailObjectOffset < 16n) return fail('ENODATA');
  if (!hashTableIsValid(journal.header(HEADER.dataHashTableOffset), journal.header(HEADER.dataHashTableSize), headerSize, arenaSize, tailObjectOffset)) return fail('ENODATA');
  if (!hashTableIsValid(journal.header(HEADER.fieldHashTableOffset), journal.header(HEADER.fieldHashTableSize), headerSize, arenaSize, tailObjectOffset)) return fail('ENODATA');
  const entryArrayOffset = journal.header(HEADER.entryArrayOffset);
  if (!offsetIsValid(entryArrayOffset, headerSize, tailObjectOffset)) return fail('ENODATA');
  if (journal.headerContains(HEADER.tailEntryArrayOffset, 4)) {
    const offset = BigInt(journal.u32(HEADER.tailEntryArrayOffset));
    const count = BigInt(journal.u32(HEADER.tailEntryArrayNEntries));
    if (!offsetIsValid(offset, headerSize, tailObjectOffset)) return fail('ENODATA');
    if (entryArrayOffset > offset) return fail('ENODATA');
    if (entryArrayOffset === 0n && offset !== 0n) return fail('ENODATA');
    if ((offset === 0n) !== (count === 0n)) return fail('ENODATA');
    if (count * BigInt(journal.entryArrayItemSize) > headerSize + arenaSize - offset) return fail('ENODATA');
  }
  if (journal.headerContains(HEADER.tailEntryOffset, 8)) {
    const offset = journal.header(HEADER.tailEntryOffset);
    if (!offsetIsValid(offset, headerSize, tailObjectOffset)) return fail('ENODATA');
    const bootIdNull = journal.slice(HEADER.tailEntryBootId, 16).every((byte) => byte === 0);
    if (offset > 0n) {
      if (bootIdNull) return fail('ENODATA');
      if (!validRealtime(journal.header(HEADER.headEntryRealtime))) return fail('ENODATA');
      if (!validRealtime(journal.header(HEADER.tailEntryRealtime))) return fail('ENODATA');
      if (!validMonotonic(journal.header(HEADER.tailEntryRealtime))) return fail('ENODATA');
    } else {
      if (journal.tailEntryBootIdFlag && !bootIdNull) return fail('ENODATA');
      if (journal.header(HEADER.headEntryRealtime) !== 0n) return fail('ENODATA');
      if (journal.header(HEADER.tailEntryRealtime) !== 0n) return fail('ENODATA');
    }
  }
  const objects = journal.header(HEADER.nObjects);
  if (objects > arenaSize / 16n) return fail('ENODATA');
  if (journal.header(HEADER.nEntries) > objects) return fail('ENODATA');
  if (journal.headerContains(HEADER.nData, 8) && journal.header(HEADER.nData) > objects) return fail('ENODATA');
  if (journal.headerContains(HEADER.nFields, 8) && journal.header(HEADER.nFields) > objects) return fail('ENODATA');
  if (journal.headerContains(HEADER.nTags, 8) && journal.header(HEADER.nTags) > objects) return fail('ENODATA');
  if (journal.headerContains(HEADER.nEntryArrays, 8) && journal.header(HEADER.nEntryArrays) > objects) return fail('ENODATA');
  if (journal.headerContains(HEADER.tailEntryArrayNEntries, 4) && BigInt(journal.u32(HEADER.tailEntryArrayNEntries)) > journal.header(HEADER.nEntries)) return fail('ENODATA');
  return { ok: true, journal };
}

export { HEADER_SIZE };
