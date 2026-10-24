import { type JournalRecord } from './JournalRecord';
import { type JournalFileInfo } from './JournalctlTool';
import { concat, utf8 } from './JournalText';
import { bytesToBinaryString } from '@/crypto/encoding';

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
  payloadSize?: (payload: Uint8Array) => number;
  compressed?: () => boolean;
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
  private objectCount = 0;
  private dirty = true;

  constructor(public identity: FileIdentity) {
    const maxFileSize = this.limits.maxSize;
    this.dataTableItems = Math.max(Math.floor(Math.floor(Math.floor(maxFileSize * 4 / 768) / 3)), DATA_HASH_TABLE_FLOOR_ITEMS);
    this.appendObject(OBJECT_HEADER_SIZE + this.dataTableItems * HASH_ITEM_SIZE);
    this.appendObject(OBJECT_HEADER_SIZE + FIELD_HASH_TABLE_ITEMS * HASH_ITEM_SIZE);
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

  private appendObject(size: number): void {
    this.allocate(this.tail, size);
    this.tail += alignObject(size);
    this.objectCount++;
  }

  registerOrphans(items: readonly Uint8Array[]): void {
    for (const bytes of items) {
      const payloadKey = key(bytes);
      if (this.rank.has(payloadKey)) continue;
      this.appendObject(COMPACT_DATA_OBJECT_SIZE + this.storedPayloadSize(bytes));
      this.rank.set(payloadKey, this.rank.size);
      this.dataChains.set(payloadKey, new EntryChain());
      const equals = bytes.indexOf(0x3d);
      const name = payloadKey.slice(0, equals < 0 ? bytes.length : equals);
      if (!this.fieldNames.has(name)) {
        this.appendObject(FIELD_OBJECT_SIZE + name.length);
        this.fieldNames.add(name);
      }
    }
  }

  private storedPayloadSize(bytes: Uint8Array): number {
    return this.identity.payloadSize === undefined ? bytes.length : this.identity.payloadSize(bytes);
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: string): JournalRecord {
    const entries: PendingEntry[] = [];
    const seen = new Set<string>();
    for (const bytes of items) {
      const payloadKey = key(bytes);
      let rank = this.rank.get(payloadKey);
      if (rank === undefined) {
        this.appendObject(COMPACT_DATA_OBJECT_SIZE + this.storedPayloadSize(bytes));
        rank = this.rank.size;
        this.rank.set(payloadKey, rank);
        this.dataChains.set(payloadKey, new EntryChain());
        const equals = bytes.indexOf(0x3d);
        const name = payloadKey.slice(0, equals < 0 ? bytes.length : equals);
        if (!this.fieldNames.has(name)) {
          this.appendObject(FIELD_OBJECT_SIZE + name.length);
          this.fieldNames.add(name);
        }
      }
      if (seen.has(payloadKey)) continue;
      seen.add(payloadKey);
      entries.push({ key: payloadKey, rank, bytes });
    }
    entries.sort((a, b) => a.rank - b.rank);
    this.appendObject(ENTRY_OBJECT_SIZE + entries.length * COMPACT_ENTRY_ITEM_SIZE);
    const allocateArray = (capacity: number): void => {
      this.appendObject(ENTRY_ARRAY_OBJECT_SIZE + capacity * COMPACT_ENTRY_ARRAY_ITEM_SIZE);
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
      compatibleFlags: ['TAIL_ENTRY_BOOT_ID'],
      incompatibleFlags: [...(this.identity.compressed?.() === false ? [] : ['COMPRESSED-ZSTD']), 'KEYED-HASH', 'COMPACT'],
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
      tags: 0,
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

  constructor(private readonly newFile: (index: number) => FileIdentity, firstSeqnum: number | SeqnumCounter = 1) {
    this.seqnum = typeof firstSeqnum === 'number' ? { next: firstSeqnum } : firstSeqnum;
    this.files.push(new JournalFile(newFile(0)));
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
    const file = new JournalFile(this.newFile(this.files.length));
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
