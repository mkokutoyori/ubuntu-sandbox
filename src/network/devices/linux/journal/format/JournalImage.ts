import { sipHash24 } from '@/network/rsyslog/SipHash';
import { zstdCompress } from '@/network/compression/zstd/ZstdEncoder';
import { zstdDecompress } from '@/network/compression/zstd/ZstdDecoder';
import { jenkinsHash64 } from './JenkinsHash';
import {
  alignObject, COMPATIBLE_SEALED, COMPATIBLE_SEALED_CONTINUOUS, COMPATIBLE_TAIL_ENTRY_BOOT_ID, DATA, DATA_OBJECT_SIZE, ENTRY, ENTRY_ARRAY, ENTRY_ARRAY_OBJECT_SIZE,
  ENTRY_OBJECT_SIZE, FIELD, FIELD_HASH_TABLE_ITEMS, FIELD_OBJECT_SIZE, HASH_ITEM_SIZE, HEADER, HEADER_SIZE, INCOMPATIBLE_COMPACT, INCOMPATIBLE_COMPRESSED_ZSTD,
  INCOMPATIBLE_KEYED_HASH, OBJECT_DATA, OBJECT_DATA_HASH_TABLE, OBJECT_ENTRY, OBJECT_ENTRY_ARRAY, OBJECT_FIELD, OBJECT_FIELD_HASH_TABLE, OBJECT_HEADER_SIZE,
  OBJECT_TAG, SIGNATURE, STATE_ARCHIVED, STATE_OFFLINE, STATE_ONLINE, TAG, TAG_LENGTH, TAG_OBJECT_SIZE,
} from './JournalLayout';

const COMPACT_ITEM = 4;
const INITIAL_CAPACITY = 64 * 1024;
const ENTRY_ARRAY_MINIMUM = 4;
const OBJECT_COMPRESSED_ZSTD = 4;
const DEFAULT_COMPRESS_THRESHOLD = 512;

export interface ImageIdentity {
  readonly fileId: Uint8Array;
  readonly machineId: Uint8Array;
  readonly seqnumId: Uint8Array;
}

export interface ImageSealer {
  put(...chunks: Uint8Array[]): void;
  appendTag(): void;
  maybeAppendTag(realtimeUsec: number): void;
}

export interface ImageOptions {
  readonly identity: ImageIdentity;
  readonly dataTableItems: number;
  readonly compressEnabled: boolean;
  readonly compressThresholdBytes?: number;
  readonly sealed: boolean;
  allocate(offset: number, size: number): number;
}

export interface AppendedEntry {
  readonly offset: number;
  readonly xorHash: bigint;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

export class JournalImage {
  private bytes = new Uint8Array(INITIAL_CAPACITY);
  private view = new DataView(this.bytes.buffer);
  private sealer: ImageSealer | null = null;
  private tailLength = HEADER_SIZE;
  private readonly fieldTableOffset: number;
  private readonly dataTableOffset: number;

  constructor(private readonly options: ImageOptions) {
    this.writeHeader();
    this.fieldTableOffset = this.appendHashTable(OBJECT_FIELD_HASH_TABLE, FIELD_HASH_TABLE_ITEMS);
    this.dataTableOffset = this.appendHashTable(OBJECT_DATA_HASH_TABLE, options.dataTableItems);
    this.setU64(HEADER.fieldHashTableOffset, this.fieldTableOffset + OBJECT_HEADER_SIZE);
    this.setU64(HEADER.fieldHashTableSize, FIELD_HASH_TABLE_ITEMS * HASH_ITEM_SIZE);
    this.setU64(HEADER.dataHashTableOffset, this.dataTableOffset + OBJECT_HEADER_SIZE);
    this.setU64(HEADER.dataHashTableSize, options.dataTableItems * HASH_ITEM_SIZE);
  }

  get length(): number {
    return this.tailLength;
  }

  snapshot(): Uint8Array {
    return this.bytes.slice(0, this.tailLength);
  }

  load(bytes: Uint8Array): void {
    this.bytes = new Uint8Array(Math.max(INITIAL_CAPACITY, bytes.length));
    this.bytes.set(bytes);
    this.view = new DataView(this.bytes.buffer);
    const tail = bytes.length >= HEADER_SIZE ? this.u64(HEADER.tailObjectOffset) : 0;
    const end = tail >= HEADER_SIZE && tail + OBJECT_HEADER_SIZE <= bytes.length ? tail + alignObject(this.u64(tail + 8)) : HEADER_SIZE;
    this.tailLength = Math.min(Math.max(end, HEADER_SIZE), Math.max(bytes.length, HEADER_SIZE));
  }

  readEntries(): ReadonlyArray<{ readonly offset: number; readonly seqnum: number; readonly realtime: number; readonly monotonic: number; readonly bootId: Uint8Array; readonly xorHash: bigint; readonly payloads: Uint8Array[] }> {
    const limit = this.bytes.length;
    const total = this.u64(HEADER.nEntries);
    const offsets: number[] = [];
    const visited = new Set<number>();
    for (let array = this.u64(HEADER.entryArrayOffset); array >= HEADER_SIZE && array + ENTRY_ARRAY_OBJECT_SIZE <= limit && !visited.has(array) && offsets.length < total; array = this.u64(array + ENTRY_ARRAY.nextEntryArrayOffset)) {
      visited.add(array);
      const capacity = Math.floor((this.u64(array + 8) - ENTRY_ARRAY_OBJECT_SIZE) / COMPACT_ITEM);
      for (let index = 0; index < capacity && offsets.length < total; index++) {
        const at = array + ENTRY_ARRAY.items + index * COMPACT_ITEM;
        if (at + COMPACT_ITEM > limit) break;
        const item = this.u32(at);
        if (item === 0) break;
        offsets.push(item);
      }
    }
    const entries = [];
    for (const offset of offsets) {
      if (offset < HEADER_SIZE || offset + ENTRY.items > limit) break;
      const payloads: Uint8Array[] = [];
      const count = Math.max(0, Math.floor((this.u64(offset + 8) - ENTRY.items) / COMPACT_ITEM));
      for (let index = 0; index < count && offset + ENTRY.items + (index + 1) * COMPACT_ITEM <= limit; index++) {
        const data = this.u32(offset + ENTRY.items + index * COMPACT_ITEM);
        if (data < HEADER_SIZE || data + DATA.payload > limit) continue;
        const payload = this.dataPayloadAt(data);
        if (payload !== null) payloads.push(payload);
      }
      entries.push({
        offset, seqnum: this.u64(offset + ENTRY.seqnum), realtime: this.u64(offset + ENTRY.realtime), monotonic: this.u64(offset + ENTRY.monotonic),
        bootId: this.slice(offset + ENTRY.bootId, 16), xorHash: this.bigU64(offset + ENTRY.xorHash), payloads,
      });
    }
    return entries;
  }

  setSeqnumId(seqnumId: Uint8Array): void {
    this.bytes.set(seqnumId, HEADER.seqnumId);
  }

  attachSealer(sealer: ImageSealer): void {
    this.sealer = sealer;
    sealer.put(this.sealedHeader());
    sealer.put(this.objectHeaderBytes(this.fieldTableOffset), this.objectHeaderBytes(this.dataTableOffset));
    sealer.appendTag();
  }

  private writeHeader(): void {
    const { identity } = this.options;
    this.ensure(HEADER_SIZE);
    this.bytes.set(new TextEncoder().encode(SIGNATURE), HEADER.signature);
    const compatible = COMPATIBLE_TAIL_ENTRY_BOOT_ID | (this.options.sealed ? COMPATIBLE_SEALED | COMPATIBLE_SEALED_CONTINUOUS : 0);
    this.view.setUint32(HEADER.compatibleFlags, compatible, true);
    this.view.setUint32(HEADER.incompatibleFlags, INCOMPATIBLE_KEYED_HASH | INCOMPATIBLE_COMPACT | (this.options.compressEnabled ? INCOMPATIBLE_COMPRESSED_ZSTD : 0), true);
    this.bytes[HEADER.state] = STATE_OFFLINE;
    this.bytes.set(identity.fileId, HEADER.fileId);
    this.bytes.set(identity.machineId, HEADER.machineId);
    this.bytes.set(identity.seqnumId, HEADER.seqnumId);
    this.setU64(HEADER.headerSize, HEADER_SIZE);
    this.setU64(HEADER.arenaSize, 0);
  }

  sealedHeader(): Uint8Array {
    const parts = [
      this.bytes.slice(HEADER.signature, HEADER.state),
      this.bytes.slice(HEADER.fileId, HEADER.tailEntryBootId),
      this.bytes.slice(HEADER.seqnumId, HEADER.arenaSize),
      this.bytes.slice(HEADER.dataHashTableOffset, HEADER.tailObjectOffset),
    ];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  private ensure(length: number): void {
    if (length <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < length) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u64(offset: number): number {
    return this.view.getUint32(offset + 4, true) * 0x100000000 + this.view.getUint32(offset, true);
  }

  setU64(offset: number, value: number): void {
    this.view.setUint32(offset, value % 0x100000000, true);
    this.view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
  }

  bigU64(offset: number): bigint {
    return this.view.getBigUint64(offset, true);
  }

  setBigU64(offset: number, value: bigint): void {
    this.view.setBigUint64(offset, value, true);
  }

  u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  setU32(offset: number, value: number): void {
    this.view.setUint32(offset, value, true);
  }

  slice(offset: number, length: number): Uint8Array {
    return this.bytes.slice(offset, offset + length);
  }

  get state(): number {
    return this.bytes[HEADER.state];
  }

  setState(state: typeof STATE_OFFLINE | typeof STATE_ONLINE | typeof STATE_ARCHIVED): void {
    this.bytes[HEADER.state] = state;
  }

  private objectHeaderBytes(offset: number): Uint8Array {
    return this.slice(offset, OBJECT_HEADER_SIZE);
  }

  private appendObject(type: number, size: number): number {
    const tail = this.u64(HEADER.tailObjectOffset);
    const offset = tail === 0 ? HEADER_SIZE : tail + alignObject(this.u64(tail + 8));
    const allocated = this.options.allocate(offset, size);
    this.setU64(HEADER.arenaSize, allocated - HEADER_SIZE);
    const end = offset + alignObject(size);
    this.ensure(end);
    this.bytes[offset] = type;
    this.setU64(offset + 8, size);
    this.setU64(HEADER.tailObjectOffset, offset);
    this.setU64(HEADER.nObjects, this.u64(HEADER.nObjects) + 1);
    this.tailLength = end;
    return offset;
  }

  private appendHashTable(type: number, items: number): number {
    return this.appendObject(type, OBJECT_HEADER_SIZE + items * HASH_ITEM_SIZE);
  }

  hashOf(bytes: Uint8Array): bigint {
    const digest = sipHash24(bytes, this.options.identity.fileId);
    let value = 0n;
    for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(digest[index]);
    return value;
  }

  private bucketOf(hash: bigint, items: number): number {
    return Number(hash % BigInt(items));
  }

  private findField(name: Uint8Array, hash: bigint): number {
    const bucket = this.fieldTableOffset + OBJECT_HEADER_SIZE + this.bucketOf(hash, FIELD_HASH_TABLE_ITEMS) * HASH_ITEM_SIZE;
    let depth = 0;
    for (let offset = this.u64(bucket); offset !== 0; offset = this.u64(offset + FIELD.nextHashOffset)) {
      depth++;
      if (this.bigU64(offset + FIELD.hash) !== hash) continue;
      const size = this.u64(offset + 8) - FIELD.payload;
      if (!sameBytes(this.slice(offset + FIELD.payload, size), name)) continue;
      this.noteDepth(HEADER.fieldHashChainDepth, depth - 1);
      return offset;
    }
    return 0;
  }

  private noteDepth(field: number, depth: number): void {
    if (depth > this.u64(field)) this.setU64(field, depth);
  }

  dataPayloadAt(offset: number): Uint8Array | null {
    const size = this.u64(offset + 8) - DATA.payload;
    if (size < 0 || offset + DATA.payload + size > this.bytes.length) return null;
    const stored = this.slice(offset + DATA.payload, this.u64(offset + 8) - DATA.payload);
    if ((this.bytes[offset + 1] & OBJECT_COMPRESSED_ZSTD) === 0) return stored;
    const result = zstdDecompress(stored);
    return result.ok ? result.bytes : null;
  }

  private findData(payload: Uint8Array, hash: bigint): number {
    const bucket = this.dataTableOffset + OBJECT_HEADER_SIZE + this.bucketOf(hash, this.options.dataTableItems) * HASH_ITEM_SIZE;
    let depth = 0;
    for (let offset = this.u64(bucket); offset !== 0; offset = this.u64(offset + DATA.nextHashOffset)) {
      depth++;
      if (this.bigU64(offset + DATA.hash) !== hash) continue;
      const stored = this.dataPayloadAt(offset);
      if (stored === null || !sameBytes(stored, payload)) continue;
      this.noteDepth(HEADER.dataHashChainDepth, depth - 1);
      return offset;
    }
    return 0;
  }

  private linkHash(tableOffset: number, items: number, hash: bigint, offset: number, nextHashField: number): void {
    const bucket = tableOffset + OBJECT_HEADER_SIZE + this.bucketOf(hash, items) * HASH_ITEM_SIZE;
    const tail = this.u64(bucket + 8);
    if (tail === 0) this.setU64(bucket, offset);
    else this.setU64(tail + nextHashField, offset);
    this.setU64(bucket + 8, offset);
  }

  private appendField(name: Uint8Array): number {
    const hash = this.hashOf(name);
    const existing = this.findField(name, hash);
    if (existing !== 0) return existing;
    const offset = this.appendObject(OBJECT_FIELD, FIELD_OBJECT_SIZE + name.length);
    this.setBigU64(offset + FIELD.hash, hash);
    this.bytes.set(name, offset + FIELD.payload);
    this.sealField(offset);
    this.linkHash(this.fieldTableOffset, FIELD_HASH_TABLE_ITEMS, hash, offset, FIELD.nextHashOffset);
    this.setU64(HEADER.nFields, this.u64(HEADER.nFields) + 1);
    return offset;
  }

  private storedForm(payload: Uint8Array): { readonly bytes: Uint8Array; readonly flags: number } {
    if (!this.options.compressEnabled || payload.length < (this.options.compressThresholdBytes ?? DEFAULT_COMPRESS_THRESHOLD)) return { bytes: payload, flags: 0 };
    const compressed = zstdCompress(payload);
    return compressed.length < payload.length ? { bytes: compressed, flags: OBJECT_COMPRESSED_ZSTD } : { bytes: payload, flags: 0 };
  }

  private appendData(payload: Uint8Array): { readonly offset: number; readonly hash: bigint } {
    const hash = this.hashOf(payload);
    const existing = this.findData(payload, hash);
    if (existing !== 0) return { offset: existing, hash };
    const equals = payload.indexOf(0x3d);
    const stored = this.storedForm(payload);
    const offset = this.appendObject(OBJECT_DATA, DATA_OBJECT_SIZE + stored.bytes.length);
    this.bytes[offset + 1] = stored.flags;
    this.setBigU64(offset + DATA.hash, hash);
    this.bytes.set(stored.bytes, offset + DATA.payload);
    this.sealData(offset);
    this.linkHash(this.dataTableOffset, this.options.dataTableItems, hash, offset, DATA.nextHashOffset);
    this.setU64(HEADER.nData, this.u64(HEADER.nData) + 1);
    const field = this.appendField(payload.subarray(0, equals));
    this.setU64(offset + DATA.nextFieldOffset, this.u64(field + FIELD.headDataOffset));
    this.setU64(field + FIELD.headDataOffset, offset);
    return { offset, hash };
  }

  private entryArrayCapacity(offset: number): number {
    return (this.u64(offset + 8) - ENTRY_ARRAY_OBJECT_SIZE) / COMPACT_ITEM;
  }

  private linkIntoArray(firstField: number, tailField: number, tailCountField: number, hidx: number, entryOffset: number): void {
    let n = 0;
    let previous = 0;
    const tail = this.u32(tailField);
    if (tail > 0) {
      n = this.entryArrayCapacity(tail);
      const used = this.u32(tailCountField);
      if (used < n) {
        this.setU32(tail + ENTRY_ARRAY.items + used * COMPACT_ITEM, entryOffset);
        this.setU32(tailCountField, used + 1);
        return;
      }
      previous = tail;
    }
    n = hidx > n ? (hidx + 1) * 2 : n * 2;
    if (n < ENTRY_ARRAY_MINIMUM) n = ENTRY_ARRAY_MINIMUM;
    const array = this.appendObject(OBJECT_ENTRY_ARRAY, ENTRY_ARRAY_OBJECT_SIZE + n * COMPACT_ITEM);
    this.setU64(HEADER.nEntryArrays, this.u64(HEADER.nEntryArrays) + 1);
    this.sealer?.put(this.objectHeaderBytes(array));
    this.setU32(array + ENTRY_ARRAY.items, entryOffset);
    if (previous === 0) this.setU64(firstField, array);
    else this.setU64(previous + ENTRY_ARRAY.nextEntryArrayOffset, array);
    this.setU32(tailField, array);
    this.setU32(tailCountField, 1);
  }

  private linkEntryIntoData(dataOffset: number, entryOffset: number): void {
    const count = this.u64(dataOffset + DATA.nEntries);
    if (count === 0) this.setU64(dataOffset + DATA.entryOffset, entryOffset);
    else this.linkIntoArray(dataOffset + DATA.entryArrayOffset, dataOffset + DATA.tailEntryArrayOffset, dataOffset + DATA.tailEntryArrayNEntries, count - 1, entryOffset);
    this.setU64(dataOffset + DATA.nEntries, count + 1);
  }

  appendEntry(payloads: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: Uint8Array): AppendedEntry {
    this.sealer?.maybeAppendTag(realtimeUsec);
    this.setState(STATE_ONLINE);
    let xorHash = 0n;
    const items: number[] = [];
    for (const payload of payloads) {
      const { offset } = this.appendData(payload);
      items.push(offset);
      xorHash ^= jenkinsHash64(payload);
    }
    const sorted = [...new Set(items)].sort((left, right) => left - right);
    const entry = this.appendObject(OBJECT_ENTRY, ENTRY_OBJECT_SIZE + sorted.length * COMPACT_ITEM);
    this.setU64(entry + ENTRY.seqnum, seqnum);
    this.setU64(entry + ENTRY.realtime, realtimeUsec);
    this.setU64(entry + ENTRY.monotonic, monotonicUsec);
    this.bytes.set(bootId, entry + ENTRY.bootId);
    this.setBigU64(entry + ENTRY.xorHash, xorHash);
    sorted.forEach((offset, index) => this.setU32(entry + ENTRY.items + index * COMPACT_ITEM, offset));
    this.sealEntry(entry);
    this.linkEntryIntoMain(entry, realtimeUsec, monotonicUsec, seqnum, bootId);
    for (const offset of sorted) this.linkEntryIntoData(offset, entry);
    return { offset: entry, xorHash };
  }

  private linkEntryIntoMain(entry: number, realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: Uint8Array): void {
    const count = this.u64(HEADER.nEntries);
    this.linkIntoArray(HEADER.entryArrayOffset, HEADER.tailEntryArrayOffset, HEADER.tailEntryArrayNEntries, count, entry);
    this.setU64(HEADER.nEntries, count + 1);
    if (this.u64(HEADER.headEntryRealtime) === 0) this.setU64(HEADER.headEntryRealtime, realtimeUsec);
    this.setU64(HEADER.tailEntryRealtime, realtimeUsec);
    this.setU64(HEADER.tailEntryMonotonic, monotonicUsec);
    this.bytes.set(bootId, HEADER.tailEntryBootId);
    this.setU64(HEADER.tailEntrySeqnum, seqnum);
    if (this.u64(HEADER.headEntrySeqnum) === 0) this.setU64(HEADER.headEntrySeqnum, seqnum);
    this.setU64(HEADER.tailEntryOffset, entry);
  }

  registerOrphans(payloads: readonly Uint8Array[]): void {
    for (const payload of payloads) this.appendData(payload);
  }

  entryPayloads(entryOffset: number): Uint8Array[] {
    const count = (this.u64(entryOffset + 8) - ENTRY.items) / COMPACT_ITEM;
    const out: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const payload = this.dataPayloadAt(this.u32(entryOffset + ENTRY.items + index * COMPACT_ITEM));
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  closeFile(realtimeUsec: number): void {
    if (this.sealer === null) return;
    this.sealer.maybeAppendTag(realtimeUsec);
    this.sealer.appendTag();
  }

  appendTagObject(): number {
    return this.appendObject(OBJECT_TAG, TAG_OBJECT_SIZE);
  }

  writeTag(offset: number, seqnum: number, epoch: number, tag: Uint8Array): void {
    this.setU64(offset + TAG.seqnum, seqnum);
    this.setU64(offset + TAG.epoch, epoch);
    this.bytes.set(tag.subarray(0, TAG_LENGTH), offset + TAG.tag);
    this.setU64(HEADER.nTags, seqnum);
  }

  tagObjectChunks(offset: number): Uint8Array[] {
    return [this.objectHeaderBytes(offset), this.slice(offset + TAG.seqnum, 16)];
  }

  private sealData(offset: number): void {
    if (this.sealer === null) return;
    const size = this.u64(offset + 8);
    this.sealer.put(this.objectHeaderBytes(offset), this.slice(offset + DATA.hash, 8), this.slice(offset + DATA.payload, size - DATA.payload));
  }

  private sealField(offset: number): void {
    if (this.sealer === null) return;
    const size = this.u64(offset + 8);
    this.sealer.put(this.objectHeaderBytes(offset), this.slice(offset + FIELD.hash, 8), this.slice(offset + FIELD.payload, size - FIELD.payload));
  }

  private sealEntry(offset: number): void {
    if (this.sealer === null) return;
    const size = this.u64(offset + 8);
    this.sealer.put(this.objectHeaderBytes(offset), this.slice(offset + ENTRY.seqnum, size - ENTRY.seqnum));
  }
}
