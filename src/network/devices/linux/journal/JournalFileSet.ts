import { type JournalRecord } from './JournalRecord';
import { type JournalFileInfo } from './JournalctlTool';
import { concat, utf8 } from './JournalText';

const ENTRY_ARRAY_MINIMUM = 4;
const FIELD_HASH_TABLE_ITEMS = 333;
const HEADER_SIZE = 272;
const ARENA_SIZE = 8_388_336;
const DEFAULT_MAX_FILE_SIZE = 128 * 1024 * 1024;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const key = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

class EntryChain {
  count = 0;
  private readonly capacities: number[] = [];

  link(): number {
    const hidx = this.count;
    this.count++;
    let remaining = hidx;
    for (const capacity of this.capacities) {
      if (remaining < capacity) return 0;
      remaining -= capacity;
    }
    const last = this.capacities.length === 0 ? 0 : this.capacities[this.capacities.length - 1];
    let capacity = hidx > last ? (hidx + 1) * 2 : last * 2;
    if (capacity < ENTRY_ARRAY_MINIMUM) capacity = ENTRY_ARRAY_MINIMUM;
    this.capacities.push(capacity);
    return 1;
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

export interface FileIdentity {
  path: string;
  fileId: string;
  seqnumId: string;
  machineId: string;
  maxFileSize?: number;
}

export type FileState = 'ONLINE' | 'OFFLINE' | 'ARCHIVED';

export class JournalFile {
  readonly records: JournalRecord[] = [];
  state: FileState = 'ONLINE';
  private readonly rank = new Map<string, number>();
  private readonly fieldNames = new Set<string>();
  private readonly dataChains = new Map<string, EntryChain>();
  private readonly mainChain = new EntryChain();
  private entryArrays = 0;

  constructor(public identity: FileIdentity) {}

  get path(): string {
    return this.identity.path;
  }

  archive(): void {
    this.state = 'ARCHIVED';
    const first = this.records[0];
    const directory = this.identity.path.slice(0, this.identity.path.lastIndexOf('/'));
    const hex = (n: number): string => n.toString(16).padStart(16, '0');
    const head = first === undefined ? hex(0) : hex(first.seqnum);
    const realtime = first === undefined ? hex(0) : hex(first.realtimeUsec);
    this.identity = { ...this.identity, path: `${directory}/system@${this.identity.seqnumId}-${head}-${realtime}.journal` };
  }

  registerOrphans(items: readonly Uint8Array[]): void {
    for (const bytes of items) {
      const payloadKey = key(bytes);
      if (this.rank.has(payloadKey)) continue;
      this.rank.set(payloadKey, this.rank.size);
      this.dataChains.set(payloadKey, new EntryChain());
      const equals = bytes.indexOf(0x3d);
      this.fieldNames.add(payloadKey.slice(0, equals < 0 ? bytes.length : equals));
    }
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: string): JournalRecord {
    const entries: Array<{ key: string; rank: number; bytes: Uint8Array }> = [];
    const seen = new Set<string>();
    for (const bytes of items) {
      const payloadKey = key(bytes);
      let rank = this.rank.get(payloadKey);
      if (rank === undefined) {
        rank = this.rank.size;
        this.rank.set(payloadKey, rank);
        this.dataChains.set(payloadKey, new EntryChain());
        const equals = bytes.indexOf(0x3d);
        this.fieldNames.add(payloadKey.slice(0, equals < 0 ? bytes.length : equals));
      }
      if (seen.has(payloadKey)) continue;
      seen.add(payloadKey);
      entries.push({ key: payloadKey, rank, bytes });
    }
    entries.sort((a, b) => a.rank - b.rank);
    this.entryArrays += this.mainChain.link();
    for (const entry of entries) {
      const chain = this.dataChains.get(entry.key) as EntryChain;
      if (chain.count === 0) chain.count = 1;
      else {
        chain.count--;
        this.entryArrays += chain.link();
        chain.count++;
      }
    }
    const fields = entries.map((entry): readonly [string, Uint8Array] => {
      const equals = entry.bytes.indexOf(0x3d);
      return [String.fromCharCode(...entry.bytes.subarray(0, equals)), entry.bytes.slice(equals + 1)] as const;
    });
    const record: JournalRecord = {
      fields,
      realtimeUsec,
      monotonicUsec,
      seqnum,
      seqnumId: this.identity.seqnumId,
      bootId,
      xorHash: fnv(entries.map(entry => entry.bytes)).toString(16),
    };
    this.records.push(record);
    return record;
  }

  info(overrides: Partial<JournalFileInfo> = {}): JournalFileInfo {
    const first = this.records[0];
    const last = this.records[this.records.length - 1];
    const maxFileSize = this.identity.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    const dataItems = Math.floor(Math.floor(Math.floor(maxFileSize * 4 / 768) / 3));
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
      incompatibleFlags: ['COMPRESSED-ZSTD', 'KEYED-HASH', 'COMPACT'],
      headerSize: HEADER_SIZE,
      arenaSize: ARENA_SIZE,
      dataHashTableSize: dataItems,
      fieldHashTableSize: FIELD_HASH_TABLE_ITEMS,
      rotateSuggested: false,
      headSeqnum: first?.seqnum ?? 0,
      tailSeqnum: last?.seqnum ?? 0,
      headRealtime: first?.realtimeUsec ?? 0,
      tailRealtime: last?.realtimeUsec ?? 0,
      tailMonotonic: last?.monotonicUsec ?? 0,
      objects: this.records.length + data + fields + this.entryArrays + 2,
      entries: this.records.length,
      data,
      fields,
      tags: 0,
      entryArrays: this.entryArrays,
      fieldHashChainDepth: fields > 0 ? 1 : 0,
      dataHashChainDepth: 0,
      diskUsageBytes: 8 * 1024 * 1024,
      ...overrides,
    };
  }
}

export class JournalFileSet {
  private readonly files: JournalFile[] = [];
  private seqnum: number;

  constructor(private readonly newFile: (index: number) => FileIdentity, firstSeqnum = 1) {
    this.seqnum = firstSeqnum;
    this.files.push(new JournalFile(newFile(0)));
  }

  get current(): JournalFile {
    return this.files[this.files.length - 1];
  }

  get all(): readonly JournalFile[] {
    return this.files;
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, bootId: string): JournalRecord {
    return this.current.append(items, realtimeUsec, monotonicUsec, this.seqnum++, bootId);
  }

  rotate(): JournalFile {
    this.current.archive();
    const file = new JournalFile(this.newFile(this.files.length));
    this.files.push(file);
    return file;
  }

  remove(predicate: (file: JournalFile) => boolean): void {
    for (let i = this.files.length - 1; i >= 0; i--) if (this.files[i] !== this.current && predicate(this.files[i])) this.files.splice(i, 1);
  }

  records(): JournalRecord[] {
    return this.files.flatMap(file => file.records);
  }
}

export const itemOf = (name: string, value: string | Uint8Array): Uint8Array => concat(utf8(`${name}=`), typeof value === 'string' ? utf8(value) : value);
