import { type JournalRecord } from './JournalRecord';
import { type JournalFileInfo } from './JournalctlTool';
import { concat, utf8 } from './JournalText';
import { bytesToBinaryString } from '@/crypto/encoding';
import { compressedPayloadSize } from './PayloadCompression';
import { sipHash24 } from '@/network/rsyslog/SipHash';
import {
  concatBytes, littleEndian, objectHeader, SealChain, TAG_OBJECT_SIZE, OBJECT_DATA, OBJECT_DATA_HASH_TABLE, OBJECT_ENTRY, OBJECT_ENTRY_ARRAY, OBJECT_FIELD,
  OBJECT_FIELD_HASH_TABLE, type SealKey,
} from './seal/SealChain';

const ENTRY_ARRAY_MINIMUM = 4;
const FIELD_HASH_TABLE_ITEMS = 333;
const DATA_HASH_TABLE_FLOOR_ITEMS = 2047;
const HEADER_SIZE = 272;
const DEFAULT_MAX_FILE_SIZE = 128 * 1024 * 1024;
const DEFAULT_MIN_FILE_SIZE = 512 * 1024;
const FILE_SIZE_INCREASE = 8 * 1024 * 1024;
const PAGE_SIZE = 4096;
const OBJECT_HEADER_SIZE = 16;
const HASH_ITEM_SIZE = 16;
const COMPACT_DATA_OBJECT_SIZE = 72;
const FIELD_OBJECT_SIZE = 40;
const ENTRY_OBJECT_SIZE = 64;
const COMPACT_ENTRY_ITEM_SIZE = 4;
const ENTRY_ARRAY_OBJECT_SIZE = 24;
const COMPACT_ENTRY_ARRAY_ITEM_SIZE = 4;
const DEFAULT_COMPRESS = { enabled: true, thresholdBytes: 512 };
const FILL_NUMERATOR = 3;
const FILL_DENOMINATOR = 4;

const alignObject = (size: number): number => Math.ceil(size / 8) * 8;
const alignPage = (size: number): number => Math.ceil(size / PAGE_SIZE) * PAGE_SIZE;

export class JournalFull extends Error {
  constructor() {
    super('Argument list too long');
    this.name = 'JournalFull';
  }
}

export interface SeqnumCounter {
  next: number;
}
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const key = (bytes: Uint8Array): string => bytesToBinaryString(bytes);

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

class EntryChain {
  count = 0;
  private readonly capacities: number[] = [];

  link(allocate: (capacity: number) => void): void {
    const hidx = this.count;
    let remaining = hidx;
    for (const capacity of this.capacities) {
      if (remaining < capacity) {
        this.count++;
        return;
      }
      remaining -= capacity;
    }
    const last = this.capacities.length === 0 ? 0 : this.capacities[this.capacities.length - 1];
    let capacity = hidx > last ? (hidx + 1) * 2 : last * 2;
    if (capacity < ENTRY_ARRAY_MINIMUM) capacity = ENTRY_ARRAY_MINIMUM;
    allocate(capacity);
    this.capacities.push(capacity);
    this.count++;
  }
}

function fnv(items: readonly Uint8Array[]): bigint {
  let hash = FNV_OFFSET;
  for (const item of items) {
    for (const byte of item) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;
    hash = ((hash ^ 0xffn) * FNV_PRIME) & MASK64;
  }
  return hash;
}

export function storedPayloadSize(bytes: Uint8Array, compress: { enabled: boolean; thresholdBytes: number }): number {
  if (!compress.enabled || bytes.length < compress.thresholdBytes) return bytes.length;
  const compressed = compressedPayloadSize(bytes);
  return compressed <= bytes.length - 1 ? compressed : bytes.length;
}

export function buildRecord(payloads: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, seqnumId: string, bootId: string): JournalRecord {
  const fields = payloads.map((bytes): readonly [string, Uint8Array] => {
    const equals = bytes.indexOf(0x3d);
    return [String.fromCharCode(...bytes.subarray(0, equals)), bytes.slice(equals + 1)] as const;
  });
  return { fields, realtimeUsec, monotonicUsec, seqnum, seqnumId, bootId, xorHash: fnv(payloads).toString(16) };
}

export function distinctPayloads(items: readonly Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const bytes of items) {
    const payloadKey = key(bytes);
    if (seen.has(payloadKey)) continue;
    seen.add(payloadKey);
    out.push(bytes);
  }
  return out;
}

export interface FileLimits {
  readonly maxSize: number;
  readonly minSize: number;
  readonly keepFree: number;
  readonly freeBytes: () => number;
}

export interface FileIdentity {
  path: string;
  fileId: string;
  seqnumId: string;
  machineId: string;
  maxFileSize?: number;
  limits?: FileLimits;
  createdUsec?: number;
  compress?: { enabled: boolean; thresholdBytes: number };
  seal?: SealKey | null;
  hasTemplate?: boolean;
}

export type FileState = 'ONLINE' | 'OFFLINE' | 'ARCHIVED';

interface PendingEntry {
  key: string;
  rank: number;
  bytes: Uint8Array;
}

export class JournalFile {
  readonly records: JournalRecord[] = [];
  state: FileState = 'ONLINE';
  private readonly rank = new Map<string, number>();
  private readonly fieldNames = new Set<string>();
  private readonly dataChains = new Map<string, EntryChain>();
  private readonly mainChain = new EntryChain();
  private entryArrays = 0;
  private tail = HEADER_SIZE;
  private allocated = HEADER_SIZE;
  private readonly dataTableItems: number;
  private readonly compress: { enabled: boolean; thresholdBytes: number };
  private objectCount = 0;
  private dirty = true;
  readonly seal: SealChain | null;
  private readonly dataOffsets = new Map<string, number>();
  private readonly dataHashes = new Map<string, Uint8Array>();
  private readonly fileIdBytes: Uint8Array;
  private readonly dataTableObjectOffset: number;
  private readonly fieldTableObjectOffset: number;

  constructor(public identity: FileIdentity) {
    this.compress = identity.compress ?? DEFAULT_COMPRESS;
    this.fileIdBytes = hexBytes(identity.fileId);
    const maxFileSize = this.limits.maxSize;
    this.dataTableItems = Math.max(Math.floor(Math.floor(Math.floor(maxFileSize * 4 / 768) / 3)), DATA_HASH_TABLE_FLOOR_ITEMS);
    const dataTableSize = OBJECT_HEADER_SIZE + this.dataTableItems * HASH_ITEM_SIZE;
    const fieldTableSize = OBJECT_HEADER_SIZE + FIELD_HASH_TABLE_ITEMS * HASH_ITEM_SIZE;
    const fieldTableOffset = this.appendObject(fieldTableSize);
    const dataTableOffset = this.appendObject(dataTableSize);
    this.dataTableObjectOffset = dataTableOffset;
    this.fieldTableObjectOffset = fieldTableOffset;
    this.seal = identity.seal === undefined || identity.seal === null ? null : new SealChain(identity.seal, () => this.appendObject(TAG_OBJECT_SIZE));
    if (this.seal !== null) {
      const creationSeqnumId = identity.hasTemplate === true ? hexBytes(identity.seqnumId) : this.fileIdBytes;
      this.seal.putHeader(this.sealedHeader(dataTableOffset + OBJECT_HEADER_SIZE, fieldTableOffset + OBJECT_HEADER_SIZE, creationSeqnumId));
      this.seal.put(objectHeader(OBJECT_FIELD_HASH_TABLE, fieldTableSize), objectHeader(OBJECT_DATA_HASH_TABLE, dataTableSize));
      this.seal.appendTag();
    }
  }

  currentSealedHeader(): Uint8Array {
    return this.sealedHeader(this.dataTableObjectOffset + OBJECT_HEADER_SIZE, this.fieldTableObjectOffset + OBJECT_HEADER_SIZE, hexBytes(this.identity.seqnumId));
  }

  private sealedHeader(dataItemsOffset: number, fieldItemsOffset: number, seqnumId: Uint8Array): Uint8Array {
    const incompatible = (this.compress.enabled ? 8 : 0) | 4 | 16;
    return concatBytes([
      new TextEncoder().encode('LPKSHHRH'), littleEndian(1 | 2 | 4, 4), littleEndian(incompatible, 4),
      this.fileIdBytes, hexBytes(this.identity.machineId),
      seqnumId, littleEndian(HEADER_SIZE, 8),
      littleEndian(dataItemsOffset, 8), littleEndian(this.dataTableItems * HASH_ITEM_SIZE, 8),
      littleEndian(fieldItemsOffset, 8), littleEndian(FIELD_HASH_TABLE_ITEMS * HASH_ITEM_SIZE, 8),
    ]);
  }

  private keyedHash(bytes: Uint8Array): Uint8Array {
    return sipHash24(bytes, this.fileIdBytes);
  }

  private sealData(payloadKey: string, bytes: Uint8Array, offset: number): void {
    if (this.seal === null) return;
    const hash = this.keyedHash(bytes);
    this.dataOffsets.set(payloadKey, offset);
    this.dataHashes.set(payloadKey, hash);
    this.seal.put(objectHeader(OBJECT_DATA, COMPACT_DATA_OBJECT_SIZE + this.storedPayloadSize(bytes)), hash, bytes);
  }

  private sealField(name: string): void {
    if (this.seal === null) return;
    const bytes = new TextEncoder().encode(name);
    this.seal.put(objectHeader(OBJECT_FIELD, FIELD_OBJECT_SIZE + name.length), this.keyedHash(bytes), bytes);
  }

  private sealEntry(entries: readonly PendingEntry[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: string): void {
    if (this.seal === null) return;
    const xor = new Uint8Array(8);
    const items: Uint8Array[] = [];
    for (const entry of entries) {
      const hash = this.dataHashes.get(entry.key) as Uint8Array;
      for (let index = 0; index < 8; index++) xor[index] ^= hash[index];
      items.push(littleEndian(this.dataOffsets.get(entry.key) as number, 4));
    }
    this.seal.put(
      objectHeader(OBJECT_ENTRY, ENTRY_OBJECT_SIZE + entries.length * COMPACT_ENTRY_ITEM_SIZE),
      littleEndian(seqnum, 8), littleEndian(realtimeUsec, 8), littleEndian(monotonicUsec, 8), hexBytes(bootId), xor, ...items,
    );
    this.seal.noteEntry(realtimeUsec);
  }

  get path(): string {
    return this.identity.path;
  }

  private get limits(): FileLimits {
    return this.identity.limits ?? {
      maxSize: this.identity.maxFileSize ?? DEFAULT_MAX_FILE_SIZE, minSize: DEFAULT_MIN_FILE_SIZE, keepFree: 0, freeBytes: () => Number.MAX_SAFE_INTEGER,
    };
  }

  get fileSize(): number {
    return this.allocated;
  }

  get createdUsec(): number {
    return this.identity.createdUsec ?? 0;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  sync(): void {
    this.dirty = false;
    if (this.state === 'ONLINE') this.state = 'OFFLINE';
  }

  archive(): void {
    this.sync();
    this.state = 'ARCHIVED';
    const first = this.records[0];
    const directory = this.identity.path.slice(0, this.identity.path.lastIndexOf('/'));
    const hex = (n: number): string => n.toString(16).padStart(16, '0');
    const head = first === undefined ? hex(0) : hex(first.seqnum);
    const realtime = first === undefined ? hex(0) : hex(first.realtimeUsec);
    const stem = this.identity.path.slice(directory.length + 1).replace(/\.journal$/, '');
    this.identity = { ...this.identity, path: `${directory}/${stem}@${this.identity.seqnumId}-${head}-${realtime}.journal` };
  }

  private allocate(offset: number, size: number): void {
    const newSize = Math.max(alignPage(offset + size), HEADER_SIZE);
    if (newSize <= this.allocated) return;
    const limits = this.limits;
    if (limits.maxSize > 0 && newSize > limits.maxSize) throw new JournalFull();
    if (newSize > limits.minSize && limits.keepFree > 0) {
      const available = Math.max(0, limits.freeBytes() - limits.keepFree);
      if (newSize - this.allocated > available) throw new JournalFull();
    }
    let grown = Math.ceil(newSize / FILE_SIZE_INCREASE) * FILE_SIZE_INCREASE;
    if (limits.maxSize > 0 && grown > limits.maxSize) grown = limits.maxSize;
    this.allocated = grown;
  }

  private appendObject(size: number): number {
    const offset = this.tail;
    this.allocate(this.tail, size);
    this.tail += alignObject(size);
    this.objectCount++;
    return offset;
  }

  registerOrphans(items: readonly Uint8Array[]): void {
    for (const bytes of items) {
      const payloadKey = key(bytes);
      if (this.rank.has(payloadKey)) continue;
      const dataOffset = this.appendObject(COMPACT_DATA_OBJECT_SIZE + this.storedPayloadSize(bytes));
      this.rank.set(payloadKey, this.rank.size);
      this.dataChains.set(payloadKey, new EntryChain());
      this.sealData(payloadKey, bytes, dataOffset);
      const equals = bytes.indexOf(0x3d);
      const name = payloadKey.slice(0, equals < 0 ? bytes.length : equals);
      if (!this.fieldNames.has(name)) {
        this.appendObject(FIELD_OBJECT_SIZE + name.length);
        this.fieldNames.add(name);
        this.sealField(name);
      }
    }
  }

  private storedPayloadSize(bytes: Uint8Array): number {
    return storedPayloadSize(bytes, this.compress);
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: string): JournalRecord {
    const entries: PendingEntry[] = [];
    const seen = new Set<string>();
    this.seal?.maybeAppendTag(realtimeUsec);
    for (const bytes of items) {
      const payloadKey = key(bytes);
      let rank = this.rank.get(payloadKey);
      if (rank === undefined) {
        const dataOffset = this.appendObject(COMPACT_DATA_OBJECT_SIZE + this.storedPayloadSize(bytes));
        rank = this.rank.size;
        this.rank.set(payloadKey, rank);
        this.dataChains.set(payloadKey, new EntryChain());
        this.sealData(payloadKey, bytes, dataOffset);
        const equals = bytes.indexOf(0x3d);
        const name = payloadKey.slice(0, equals < 0 ? bytes.length : equals);
        if (!this.fieldNames.has(name)) {
          this.appendObject(FIELD_OBJECT_SIZE + name.length);
          this.fieldNames.add(name);
          this.sealField(name);
        }
      }
      if (seen.has(payloadKey)) continue;
      seen.add(payloadKey);
      entries.push({ key: payloadKey, rank, bytes });
    }
    entries.sort((a, b) => a.rank - b.rank);
    this.appendObject(ENTRY_OBJECT_SIZE + entries.length * COMPACT_ENTRY_ITEM_SIZE);
    this.sealEntry(entries, realtimeUsec, monotonicUsec, seqnum, bootId);
    const allocateArray = (capacity: number): void => {
      const size = ENTRY_ARRAY_OBJECT_SIZE + capacity * COMPACT_ENTRY_ARRAY_ITEM_SIZE;
      this.appendObject(size);
      this.seal?.put(objectHeader(OBJECT_ENTRY_ARRAY, size));
      this.entryArrays++;
    };
    this.mainChain.link(allocateArray);
    for (const entry of entries) {
      const chain = this.dataChains.get(entry.key) as EntryChain;
      if (chain.count === 0) chain.count = 1;
      else {
        chain.count--;
        try {
          chain.link(allocateArray);
        } finally {
          chain.count++;
        }
      }
    }
    const record = buildRecord(entries.map(entry => entry.bytes), realtimeUsec, monotonicUsec, seqnum, this.identity.seqnumId, bootId);
    this.records.push(record);
    this.state = 'ONLINE';
    this.dirty = true;
    return record;
  }

  rotateSuggested(maxFileUsec: number, nowUsec: number): boolean {
    const data = this.rank.size;
    if (data * FILL_DENOMINATOR > this.dataTableItems * FILL_NUMERATOR) return true;
    if (this.fieldNames.size * FILL_DENOMINATOR > FIELD_HASH_TABLE_ITEMS * FILL_NUMERATOR) return true;
    if (data > 0 && this.fieldNames.size === 0) return true;
    const head = this.records[0]?.realtimeUsec ?? 0;
    return maxFileUsec > 0 && head > 0 && nowUsec > head + maxFileUsec;
  }

  info(overrides: Partial<JournalFileInfo> = {}): JournalFileInfo {
    const first = this.records[0];
    const last = this.records[this.records.length - 1];
    const data = this.rank.size;
    const fields = this.fieldNames.size;
    return {
      path: this.identity.path,
      fileId: this.identity.fileId,
      machineId: this.identity.machineId,
      bootId: last?.bootId ?? '00000000000000000000000000000000',
      seqnumId: this.identity.seqnumId,
      state: this.state,
      compatibleFlags: [...(this.seal === null ? [] : ['SEALED', 'SEALED_CONTINUOUS']), 'TAIL_ENTRY_BOOT_ID'],
      incompatibleFlags: [...(this.compress.enabled ? ['COMPRESSED-ZSTD'] : []), 'KEYED-HASH', 'COMPACT'],
      headerSize: HEADER_SIZE,
      arenaSize: this.allocated - HEADER_SIZE,
      dataHashTableSize: this.dataTableItems,
      fieldHashTableSize: FIELD_HASH_TABLE_ITEMS,
      rotateSuggested: false,
      headSeqnum: first?.seqnum ?? 0,
      tailSeqnum: last?.seqnum ?? 0,
      headRealtime: first?.realtimeUsec ?? 0,
      tailRealtime: last?.realtimeUsec ?? 0,
      tailMonotonic: last?.monotonicUsec ?? 0,
      objects: this.objectCount,
      entries: this.records.length,
      data,
      fields,
      tags: this.seal?.tagCount ?? 0,
      entryArrays: this.entryArrays,
      fieldHashChainDepth: fields > 0 ? 1 : 0,
      dataHashChainDepth: 0,
      diskUsageBytes: this.allocated,
      ...overrides,
    };
  }
}

export class JournalFileSet {
  private readonly files: JournalFile[] = [];
  private readonly seqnum: SeqnumCounter;

  constructor(private readonly newFile: (index: number) => FileIdentity, firstSeqnum: number | SeqnumCounter = 1, firstHasTemplate = false) {
    this.seqnum = typeof firstSeqnum === 'number' ? { next: firstSeqnum } : firstSeqnum;
    this.files.push(new JournalFile({ ...newFile(0), hasTemplate: firstHasTemplate }));
  }

  get current(): JournalFile {
    return this.files[this.files.length - 1];
  }

  get all(): readonly JournalFile[] {
    return this.files;
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, bootId: string): JournalRecord {
    const record = this.current.append(items, realtimeUsec, monotonicUsec, this.seqnum.next, bootId);
    this.seqnum.next++;
    return record;
  }

  rotate(): JournalFile {
    this.current.archive();
    const file = new JournalFile({ ...this.newFile(this.files.length), hasTemplate: true });
    this.files.push(file);
    return file;
  }

  get isRetired(): boolean {
    return this.current.state === 'ARCHIVED';
  }

  delete(file: JournalFile): void {
    const index = this.files.indexOf(file);
    if (index >= 0) this.files.splice(index, 1);
  }

  remove(predicate: (file: JournalFile) => boolean): void {
    for (let i = this.files.length - 1; i >= 0; i--) if (this.files[i] !== this.current && predicate(this.files[i])) this.files.splice(i, 1);
  }

  records(): JournalRecord[] {
    return this.files.flatMap(file => file.records);
  }
}

export const itemOf = (name: string, value: string | Uint8Array): Uint8Array => concat(utf8(`${name}=`), typeof value === 'string' ? utf8(value) : value);
