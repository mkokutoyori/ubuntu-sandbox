import { type JournalRecord } from './JournalRecord';
import { type JournalFileInfo } from './JournalctlTool';
import { concat, utf8 } from './JournalText';
import { bytesToBinaryString } from '@/crypto/encoding';
import { SealChain, type SealKey } from './seal/SealChain';
import { JournalImage } from './format/JournalImage';
import { jenkinsHash64 } from './format/JenkinsHash';
import { HEADER, HEADER_SIZE, STATE_ARCHIVED, STATE_OFFLINE, STATE_ONLINE } from './format/JournalLayout';
import { zstdCompress } from '@/network/compression/zstd/ZstdEncoder';

const FIELD_HASH_TABLE_ITEMS = 333;
const DATA_HASH_TABLE_FLOOR_ITEMS = 2047;
const DEFAULT_MAX_FILE_SIZE = 128 * 1024 * 1024;
const DEFAULT_MIN_FILE_SIZE = 512 * 1024;
const FILE_SIZE_INCREASE = 8 * 1024 * 1024;
const PAGE_SIZE = 4096;
const DEFAULT_COMPRESS = { enabled: true, thresholdBytes: 512 };
const FILL_NUMERATOR = 3;
const FILL_DENOMINATOR = 4;

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

const key = (bytes: Uint8Array): string => bytesToBinaryString(bytes);

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

export function storedPayloadSize(bytes: Uint8Array, compress: { enabled: boolean; thresholdBytes: number }): number {
  if (!compress.enabled || bytes.length < compress.thresholdBytes) return bytes.length;
  const compressed = zstdCompress(bytes).length;
  return compressed < bytes.length ? compressed : bytes.length;
}

export function buildRecord(payloads: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, seqnumId: string, bootId: string): JournalRecord {
  const fields = payloads.map((bytes): readonly [string, Uint8Array] => {
    const equals = bytes.indexOf(0x3d);
    return [String.fromCharCode(...bytes.subarray(0, equals)), bytes.slice(equals + 1)] as const;
  });
  let xor = 0n;
  for (const payload of payloads) xor ^= jenkinsHash64(payload);
  return { fields, realtimeUsec, monotonicUsec, seqnum, seqnumId, bootId, xorHash: xor.toString(16) };
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

const STATE_NAMES: Readonly<Record<number, FileState>> = { [STATE_OFFLINE]: 'OFFLINE', [STATE_ONLINE]: 'ONLINE', [STATE_ARCHIVED]: 'ARCHIVED' };
const STATE_CODES: Readonly<Record<FileState, number>> = { OFFLINE: STATE_OFFLINE, ONLINE: STATE_ONLINE, ARCHIVED: STATE_ARCHIVED };

export class JournalFile {
  readonly records: JournalRecord[] = [];
  readonly seal: SealChain | null;
  private readonly image: JournalImage;
  private readonly compress: { enabled: boolean; thresholdBytes: number };
  private readonly dataTableItems: number;
  private allocated = HEADER_SIZE;
  private dirty = true;
  version = 0;

  constructor(public identity: FileIdentity) {
    this.compress = identity.compress ?? DEFAULT_COMPRESS;
    const fileId = hexBytes(identity.fileId);
    const seqnumId = hexBytes(identity.seqnumId);
    this.dataTableItems = Math.max(Math.floor(Math.floor(Math.floor(this.limits.maxSize * 4 / 768) / 3)), DATA_HASH_TABLE_FLOOR_ITEMS);
    const sealed = identity.seal !== undefined && identity.seal !== null;
    this.image = new JournalImage({
      identity: { fileId, machineId: hexBytes(identity.machineId), seqnumId: sealed && identity.hasTemplate !== true ? fileId : seqnumId },
      dataTableItems: this.dataTableItems,
      compressEnabled: this.compress.enabled,
      compressThresholdBytes: this.compress.thresholdBytes,
      sealed,
      allocate: (offset, size) => this.allocate(offset, size),
    });
    if (sealed) {
      this.seal = new SealChain(
        identity.seal as SealKey, () => this.image.appendTagObject(), (offset, seqnum, epoch, tag) => this.image.writeTag(offset, seqnum, epoch, tag),
      );
      this.image.attachSealer(this.seal);
    } else {
      this.seal = null;
    }
    this.image.setSeqnumId(seqnumId);
    this.image.setState(STATE_ONLINE);
  }

  get state(): FileState {
    return STATE_NAMES[this.image.state] ?? 'ONLINE';
  }

  set state(state: FileState) {
    this.image.setState(STATE_CODES[state] as typeof STATE_OFFLINE);
    this.version++;
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

  usedBytes(): Uint8Array {
    return this.image.snapshot();
  }

  loadBytes(bytes: Uint8Array): void {
    this.image.load(bytes);
    this.allocated = bytes.length;
    const hex = (id: Uint8Array): string => Array.from(id, (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.records.length = 0;
    for (const entry of this.image.readEntries()) {
      this.records.push({ ...buildRecord(entry.payloads, entry.realtime, entry.monotonic, entry.seqnum, this.identity.seqnumId, hex(entry.bootId)), xorHash: entry.xorHash.toString(16) });
    }
    this.version++;
  }

  sync(): void {
    this.dirty = false;
    if (this.state === 'ONLINE') this.state = 'OFFLINE';
  }

  archive(realtimeUsec: number): void {
    this.sync();
    this.image.closeFile(realtimeUsec);
    this.state = 'ARCHIVED';
    const first = this.records[0];
    const directory = this.identity.path.slice(0, this.identity.path.lastIndexOf('/'));
    const hex = (n: number): string => n.toString(16).padStart(16, '0');
    const head = first === undefined ? hex(0) : hex(first.seqnum);
    const realtime = first === undefined ? hex(0) : hex(first.realtimeUsec);
    const stem = this.identity.path.slice(directory.length + 1).replace(/\.journal$/, '');
    this.identity = { ...this.identity, path: `${directory}/${stem}@${this.identity.seqnumId}-${head}-${realtime}.journal` };
  }

  private allocate(offset: number, size: number): number {
    const newSize = Math.max(alignPage(offset + size), HEADER_SIZE);
    if (newSize <= this.allocated) return this.allocated;
    const limits = this.limits;
    if (limits.maxSize > 0 && newSize > limits.maxSize) throw new JournalFull();
    if (newSize > limits.minSize && limits.keepFree > 0) {
      const available = Math.max(0, limits.freeBytes() - limits.keepFree);
      if (newSize - this.allocated > available) throw new JournalFull();
    }
    let grown = Math.ceil(newSize / FILE_SIZE_INCREASE) * FILE_SIZE_INCREASE;
    if (limits.maxSize > 0 && grown > limits.maxSize) grown = limits.maxSize;
    this.allocated = grown;
    return grown;
  }

  registerOrphans(items: readonly Uint8Array[]): void {
    this.image.registerOrphans(items);
    this.version++;
  }

  append(items: readonly Uint8Array[], realtimeUsec: number, monotonicUsec: number, seqnum: number, bootId: string): JournalRecord {
    const entry = this.image.appendEntry(items, realtimeUsec, monotonicUsec, seqnum, hexBytes(bootId));
    const record: JournalRecord = {
      ...buildRecord(this.image.entryPayloads(entry.offset), realtimeUsec, monotonicUsec, seqnum, this.identity.seqnumId, bootId), xorHash: entry.xorHash.toString(16),
    };
    this.records.push(record);
    this.dirty = true;
    this.version++;
    return record;
  }

  rotateSuggested(maxFileUsec: number, nowUsec: number): boolean {
    const data = this.image.u64(HEADER.nData);
    const fields = this.image.u64(HEADER.nFields);
    if (data * FILL_DENOMINATOR > this.dataTableItems * FILL_NUMERATOR) return true;
    if (fields * FILL_DENOMINATOR > FIELD_HASH_TABLE_ITEMS * FILL_NUMERATOR) return true;
    if (data > 0 && fields === 0) return true;
    const head = this.records[0]?.realtimeUsec ?? 0;
    return maxFileUsec > 0 && head > 0 && nowUsec > head + maxFileUsec;
  }

  info(overrides: Partial<JournalFileInfo> = {}): JournalFileInfo {
    const first = this.records[0];
    const last = this.records[this.records.length - 1];
    const counter = (field: number): number => this.image.u64(field);
    const flags = this.image.u32(HEADER.incompatibleFlags);
    return {
      path: this.identity.path,
      fileId: this.identity.fileId,
      machineId: this.identity.machineId,
      bootId: last?.bootId ?? '00000000000000000000000000000000',
      seqnumId: this.identity.seqnumId,
      state: this.state,
      compatibleFlags: [...(this.seal === null ? [] : ['SEALED', 'SEALED_CONTINUOUS']), 'TAIL_ENTRY_BOOT_ID'],
      incompatibleFlags: [...((flags & 8) !== 0 ? ['COMPRESSED-ZSTD'] : []), 'KEYED-HASH', 'COMPACT'],
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
      objects: counter(HEADER.nObjects),
      entries: this.records.length,
      data: counter(HEADER.nData),
      fields: counter(HEADER.nFields),
      tags: counter(HEADER.nTags),
      entryArrays: counter(HEADER.nEntryArrays),
      fieldHashChainDepth: counter(HEADER.fieldHashChainDepth),
      dataHashChainDepth: counter(HEADER.dataHashChainDepth),
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

  rotate(realtimeUsec: number): JournalFile {
    this.current.archive(realtimeUsec);
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
