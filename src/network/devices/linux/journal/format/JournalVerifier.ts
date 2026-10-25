import type { Errno } from '@/network/core/Errno';
import { strerror } from '@/network/core/Errno';
import { epochOf, evolve, generateMasterKey, seek, type MasterKey } from '../seal/Fsprg';
import { tagKey, tagValue } from '../seal/SealChain';
import type { VerificationKey } from '../seal/SealingKeyFile';
import { DATA, ENTRY, ENTRY_ARRAY, FIELD, HEADER, OBJECT_DATA, OBJECT_DATA_HASH_TABLE, OBJECT_ENTRY, OBJECT_ENTRY_ARRAY, OBJECT_FIELD, OBJECT_FIELD_HASH_TABLE, OBJECT_TAG, OBJECT_UNUSED } from './JournalLayout';
import { align64, JournalView, U64_MAX, valid64, validEpoch, validMonotonic, validRealtime } from './JournalView';

const OBJECT_COMPRESSED_MASK = 7;
const COMPATIBLE_SUPPORTED = 1 | 2 | 4;
const UINT64_NONE = U64_MAX;
const CHAIN_CACHE_MAX = 20;
const TEST_FOUND = 0;
const TEST_LEFT = 1;
const TEST_RIGHT = 2;
const TEST_GOTO_NEXT = 3;
const TEST_GOTO_PREVIOUS = 4;
const CORRUPT = -1;

type Direction = 'down' | 'up';

interface Bounds {
  m: bigint;
  left: bigint;
  right: bigint;
}

function testOffset(p: bigint, needle: bigint): number {
  if (p === needle) return TEST_FOUND;
  return p < needle ? TEST_LEFT : TEST_RIGHT;
}

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [OBJECT_UNUSED]: 'unused', [OBJECT_DATA]: 'data', [OBJECT_FIELD]: 'field', [OBJECT_ENTRY]: 'entry', [OBJECT_DATA_HASH_TABLE]: 'data hash table',
  [OBJECT_FIELD_HASH_TABLE]: 'field hash table', [OBJECT_ENTRY_ARRAY]: 'entry array', [OBJECT_TAG]: 'tag',
};

export type VerifyResult =
  | { readonly ok: true; readonly log: readonly string[]; readonly first: bigint; readonly validated: bigint; readonly last: bigint; readonly errno?: undefined; readonly corruptionOffset?: undefined; readonly size?: undefined }
  | { readonly ok: false; readonly errno: Errno; readonly log: readonly string[]; readonly corruptionOffset: number | null; readonly size: number; readonly first?: undefined; readonly validated?: undefined; readonly last?: undefined };

interface ChainCacheItem {
  first: bigint;
  array: bigint;
  begin: bigint;
  total: bigint;
  lastIndex: bigint;
}

class Failure extends Error {
  constructor(readonly errno: Errno) {
    super(errno);
  }
}

const hex6 = (value: bigint | number): string => BigInt(value).toString(16).padStart(6, '0');

export function verifyJournal(
  journal: JournalView, key: VerificationKey | null, formatTimestamp: (usec: number) => string,
): VerifyResult {
  return new Verification(journal, key, formatTimestamp).run();
}

class Verification {
  private readonly log: string[] = [];
  private position = 0n;
  private readonly chainCache = new Map<bigint, ChainCacheItem>();
  private dataTableMapped = false;
  private dataOffsets: bigint[] = [];
  private entryOffsets: bigint[] = [];
  private entryArrayOffsets: bigint[] = [];
  private master: MasterKey | null = null;
  private fsprgState: Uint8Array | null = null;

  constructor(
    private readonly journal: JournalView,
    private readonly key: VerificationKey | null,
    private readonly formatTimestamp: (usec: number) => string,
  ) {}

  private error(offset: bigint | number, message: string): void {
    this.log.push(`${hex6(offset)}: ${message}`);
  }

  private errorErrno(offset: bigint | number, errno: Errno, message: string): void {
    this.log.push(`${hex6(offset)}: ${message}: ${strerror(errno)}`);
  }

  private fail(errno: Errno): never {
    throw new Failure(errno);
  }

  private move(type: number, offset: bigint): number {
    const result = this.journal.moveToObject(type, offset);
    if (!result.ok) throw new Failure(result.errno);
    return result.offset;
  }

  run(): VerifyResult {
    const { journal } = this;
    if (this.key === null && journal.sealed) return { ok: false, errno: 'ENOKEY', log: this.log, corruptionOffset: null, size: journal.size };
    try {
      const outcome = this.verify();
      return { ok: true, log: this.log, ...outcome };
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      return { ok: false, errno: error.errno, log: this.log, corruptionOffset: Number(this.position), size: journal.size };
    }
  }

  private verify(): { first: bigint; validated: bigint; last: bigint } {
    const { journal } = this;
    const sealedKey = this.key;
    if ((journal.compatibleFlags & ~COMPATIBLE_SUPPORTED) !== 0) {
      this.log.push('Cannot verify file with unknown extensions.');
      this.fail('EOPNOTSUPP');
    }
    for (let index = 0; index < 7; index++) {
      if (journal.u8(HEADER.state + 1 + index) !== 0) {
        this.error(HEADER.state + 1 + index, 'Reserved field is non-zero');
        this.fail('EBADMSG');
      }
    }
    this.position = 0n;
    if (journal.sealed && !journal.sealedContinuous) {
      this.log.push(`${hex6(0)}: This log file was sealed with an old journald version where the sequence of seals might not be continuous. We cannot guarantee completeness.`);
    }
    const headerSize = journal.header(HEADER.headerSize);
    const tailObjectOffset = journal.header(HEADER.tailObjectOffset);
    let nObjects = 0n;
    let nEntries = 0n;
    let nData = 0n;
    let nFields = 0n;
    let nDataTables = 0n;
    let nFieldTables = 0n;
    let nEntryArrays = 0n;
    let nTags = 0n;
    let entrySeqnum = 0n;
    let entryMonotonic = 0n;
    let entryRealtime = 0n;
    let entryBootId: Uint8Array = new Uint8Array(16);
    let entrySeqnumSet = false;
    let entryMonotonicSet = false;
    let entryRealtimeSet = false;
    let foundMainEntryArray = false;
    let minEntryRealtime = U64_MAX;
    let maxEntryRealtime = 0n;
    let lastEpoch = 0n;
    let lastTagRealtime = 0n;
    let lastTag = 0n;
    let foundLast = false;
    this.position = headerSize;
    for (;;) {
      if (tailObjectOffset === 0n) break;
      const found = journal.moveToObject(OBJECT_UNUSED, this.position);
      if (!found.ok) {
        this.errorErrno(this.position, found.errno, 'Invalid object');
        this.fail(found.errno);
      }
      const at = found.offset;
      const p = this.position;
      if (p > tailObjectOffset) {
        this.error(HEADER.tailObjectOffset, `Invalid tail object pointer (${p} > ${tailObjectOffset})`);
        this.fail('EBADMSG');
      }
      nObjects++;
      const verified = this.objectVerify(p, at);
      if (verified !== null) {
        this.errorErrno(p, verified, 'Invalid object contents');
        this.fail(verified);
      }
      const flags = journal.objectFlags(at);
      if (((flags & 1) !== 0 ? 1 : 0) + ((flags & 2) !== 0 ? 1 : 0) + ((flags & 4) !== 0 ? 1 : 0) > 1) {
        this.error(p, `Object has multiple compression flags set (flags: 0x${flags.toString(16)})`);
        this.fail('EINVAL');
      }
      if ((flags & 1) !== 0 && (journal.incompatibleFlags & 1) === 0) {
        this.error(p, 'XZ compressed object in file without XZ compression');
        this.fail('EBADMSG');
      }
      if ((flags & 2) !== 0 && (journal.incompatibleFlags & 2) === 0) {
        this.error(p, 'LZ4 compressed object in file without LZ4 compression');
        this.fail('EBADMSG');
      }
      if ((flags & 4) !== 0 && (journal.incompatibleFlags & 8) === 0) {
        this.error(p, 'ZSTD compressed object in file without ZSTD compression');
        this.fail('EBADMSG');
      }
      switch (journal.objectType(at)) {
        case OBJECT_DATA:
          this.dataOffsets.push(p);
          nData++;
          break;
        case OBJECT_FIELD:
          nFields++;
          break;
        case OBJECT_ENTRY: {
          if (journal.sealed && nTags <= 0n) {
            this.error(p, 'First entry before first tag');
            this.fail('EBADMSG');
          }
          this.entryOffsets.push(p);
          const realtime = journal.u64(at + ENTRY.realtime);
          if (realtime < lastTagRealtime) {
            this.error(p, `Older entry after newer tag (${realtime} < ${lastTagRealtime})`);
            this.fail('EBADMSG');
          }
          const seqnum = journal.u64(at + ENTRY.seqnum);
          if (!entrySeqnumSet && seqnum !== journal.header(HEADER.headEntrySeqnum)) {
            this.error(p, `Head entry sequence number incorrect (${seqnum} != ${journal.header(HEADER.headEntrySeqnum)})`);
            this.fail('EBADMSG');
          }
          if (entrySeqnumSet && entrySeqnum >= seqnum) {
            this.error(p, `Entry sequence number out of synchronization (${entrySeqnum} >= ${seqnum})`);
            this.fail('EBADMSG');
          }
          entrySeqnum = seqnum;
          entrySeqnumSet = true;
          const monotonic = journal.u64(at + ENTRY.monotonic);
          const bootId = journal.slice(at + ENTRY.bootId, 16);
          if (entryMonotonicSet && Buffer.from(entryBootId).equals(Buffer.from(bootId)) && entryMonotonic > monotonic) {
            this.error(p, `Entry timestamp out of synchronization (${entryMonotonic} > ${monotonic})`);
            this.fail('EBADMSG');
          }
          entryMonotonic = monotonic;
          entryBootId = Uint8Array.from(bootId);
          entryMonotonicSet = true;
          if (!entryRealtimeSet && realtime !== journal.header(HEADER.headEntryRealtime)) {
            this.error(p, `Head entry realtime timestamp incorrect (${realtime} != ${journal.header(HEADER.headEntryRealtime)})`);
            this.fail('EBADMSG');
          }
          entryRealtime = realtime;
          entryRealtimeSet = true;
          if (realtime > maxEntryRealtime) maxEntryRealtime = realtime;
          if (realtime < minEntryRealtime) minEntryRealtime = realtime;
          nEntries++;
          break;
        }
        case OBJECT_DATA_HASH_TABLE:
          this.verifyHashTable(at, p, nDataTables, journal.header(HEADER.dataHashTableOffset), journal.header(HEADER.dataHashTableSize));
          nDataTables++;
          break;
        case OBJECT_FIELD_HASH_TABLE:
          this.verifyHashTable(at, p, nFieldTables, journal.header(HEADER.fieldHashTableOffset), journal.header(HEADER.fieldHashTableSize));
          nFieldTables++;
          break;
        case OBJECT_ENTRY_ARRAY:
          this.entryArrayOffsets.push(p);
          if (p === journal.header(HEADER.entryArrayOffset)) {
            if (foundMainEntryArray) {
              this.error(p, 'More than one main entry array');
              this.fail('EBADMSG');
            }
            foundMainEntryArray = true;
          }
          nEntryArrays++;
          break;
        case OBJECT_TAG: {
          if (!journal.sealed) {
            this.error(p, 'Tag object in file without sealing');
            this.fail('EBADMSG');
          }
          const seqnum = journal.u64(at + 16);
          if (seqnum !== nTags + 1n) {
            this.error(p, `Tag sequence number out of synchronization (${seqnum} != ${nTags + 1n})`);
            this.fail('EBADMSG');
          }
          const epoch = journal.u64(at + 24);
          if (journal.sealedContinuous) {
            if (!(nTags === 0n || (nTags === 1n && epoch === lastEpoch) || epoch === (lastEpoch + 1n) % (1n << 64n))) {
              this.error(p, `Epoch sequence not continuous (${epoch} vs ${lastEpoch})`);
              this.fail('EBADMSG');
            }
          } else if (epoch < lastEpoch) {
            this.error(p, `Epoch sequence out of synchronization (${epoch} < ${lastEpoch})`);
            this.fail('EBADMSG');
          }
          if (journal.sealed && sealedKey !== null) {
            const start = (BigInt(sealedKey.startUsec) + epoch * BigInt(sealedKey.intervalUsec)) & U64_MAX;
            const interval = BigInt(sealedKey.intervalUsec);
            const end = start > U64_MAX - interval ? U64_MAX : start + interval;
            if (entryRealtimeSet && entryRealtime >= end) {
              this.error(p, `tag/entry realtime timestamp out of synchronization (${entryRealtime} >= ${start + interval})`);
              this.fail('EBADMSG');
            }
            if (maxEntryRealtime >= end) {
              this.error(p, `Entry realtime (${maxEntryRealtime}, ${this.stamp(maxEntryRealtime)}) is too late with respect to tag (${end}, ${this.stamp(end)})`);
              this.fail('EBADMSG');
            }
            if (minEntryRealtime < start) {
              this.error(p, `Entry realtime (${minEntryRealtime}, ${this.stamp(minEntryRealtime)}) is too early with respect to tag (${start}, ${this.stamp(start)})`);
              this.fail('EBADMSG');
            }
            minEntryRealtime = U64_MAX;
            this.seekState(epoch, sealedKey);
            const chunks: Uint8Array[] = [];
            let q: bigint;
            if (lastTag === 0n) {
              chunks.push(this.sealedHeader());
              q = headerSize;
            } else {
              q = lastTag;
            }
            while (q <= p) {
              const object = journal.moveToObject(OBJECT_UNUSED, q);
              if (!object.ok) this.fail(object.errno);
              const size = journal.objectSize(Number(q));
              this.hmacObject(chunks, Number(q), size);
              q += align64(size);
            }
            const tagNow = journal.moveToObject(OBJECT_UNUSED, p);
            if (!tagNow.ok) this.fail(tagNow.errno);
            const expected = tagValue(tagKey(this.fsprgState as Uint8Array), chunks);
            const stored = journal.slice(at + 32, 32);
            if (!Buffer.from(expected).equals(Buffer.from(stored))) {
              this.error(p, 'Tag failed verification');
              this.fail('EBADMSG');
            }
            lastTagRealtime = start;
          }
          lastTag = p + align64(journal.objectSize(at));
          lastEpoch = epoch;
          nTags++;
          break;
        }
        default:
          break;
      }
      if (p === tailObjectOffset) {
        foundLast = true;
        break;
      }
      this.position = p + align64(journal.objectSize(at));
    }
    if (!foundLast && tailObjectOffset !== 0n) {
      this.error(tailObjectOffset, `Tail object pointer dead (${tailObjectOffset} != 0)`);
      this.fail('EBADMSG');
    }
    if (nObjects !== journal.header(HEADER.nObjects)) {
      this.error(HEADER.nObjects, `Object number mismatch (${nObjects} != ${journal.header(HEADER.nObjects)})`);
      this.fail('EBADMSG');
    }
    if (nEntries !== journal.header(HEADER.nEntries)) {
      this.error(HEADER.nEntries, `Entry number mismatch (${nEntries} != ${journal.header(HEADER.nEntries)})`);
      this.fail('EBADMSG');
    }
    if (journal.headerContains(HEADER.nData, 8) && nData !== journal.header(HEADER.nData)) {
      this.error(HEADER.nData, `Data number mismatch (${nData} != ${journal.header(HEADER.nData)})`);
      this.fail('EBADMSG');
    }
    if (journal.headerContains(HEADER.nFields, 8) && nFields !== journal.header(HEADER.nFields)) {
      this.error(HEADER.nFields, `Field number mismatch (${nFields} != ${journal.header(HEADER.nFields)})`);
      this.fail('EBADMSG');
    }
    if (journal.headerContains(HEADER.nTags, 8) && nTags !== journal.header(HEADER.nTags)) {
      this.error(HEADER.nTags, `Tag number mismatch (${nTags} != ${journal.header(HEADER.nTags)})`);
      this.fail('EBADMSG');
    }
    if (journal.headerContains(HEADER.nEntryArrays, 8) && nEntryArrays !== journal.header(HEADER.nEntryArrays)) {
      this.error(HEADER.nEntryArrays, `Entry array number mismatch (${nEntryArrays} != ${journal.header(HEADER.nEntryArrays)})`);
      this.fail('EBADMSG');
    }
    if (!foundMainEntryArray && journal.header(HEADER.entryArrayOffset) !== 0n) {
      this.error(0, 'Missing main entry array');
      this.fail('EBADMSG');
    }
    if (entrySeqnumSet && entrySeqnum !== journal.header(HEADER.tailEntrySeqnum)) {
      this.error(HEADER.tailEntrySeqnum, `Tail entry sequence number incorrect (${entrySeqnum} != ${journal.header(HEADER.tailEntrySeqnum)})`);
      this.fail('EBADMSG');
    }
    if (entryMonotonicSet && Buffer.from(entryBootId).equals(Buffer.from(journal.slice(HEADER.tailEntryBootId, 16))) && journal.tailEntryBootIdFlag && entryMonotonic !== journal.header(HEADER.tailEntryMonotonic)) {
      this.error(0, `Invalid tail monotonic timestamp (${entryMonotonic} != ${journal.header(HEADER.tailEntryMonotonic)})`);
      this.fail('EBADMSG');
    }
    if (entryRealtimeSet && entryRealtime !== journal.header(HEADER.tailEntryRealtime)) {
      this.error(0, `Invalid tail realtime timestamp (${entryRealtime} != ${journal.header(HEADER.tailEntryRealtime)})`);
      this.fail('EBADMSG');
    }
    this.verifyEntryArray();
    this.verifyDataHashTable();
    return { first: journal.header(HEADER.headEntryRealtime), validated: lastTagRealtime + BigInt(sealedKey?.intervalUsec ?? 0), last: journal.header(HEADER.tailEntryRealtime) };
  }

  private stamp(usec: bigint): string {
    return this.formatTimestamp(Number(usec));
  }

  private sealedHeader(): Uint8Array {
    const { journal } = this;
    const parts = [
      journal.slice(HEADER.signature, HEADER.state), journal.slice(HEADER.fileId, HEADER.tailEntryBootId - HEADER.fileId),
      journal.slice(HEADER.seqnumId, HEADER.arenaSize - HEADER.seqnumId), journal.slice(HEADER.dataHashTableOffset, HEADER.tailObjectOffset - HEADER.dataHashTableOffset),
    ];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  private hmacObject(chunks: Uint8Array[], at: number, size: bigint): void {
    const { journal } = this;
    chunks.push(journal.slice(at, 16));
    switch (journal.objectType(at)) {
      case OBJECT_DATA:
        chunks.push(journal.slice(at + DATA.hash, 8), journal.slice(at + journal.dataPayloadOffset, Number(size) - journal.dataPayloadOffset));
        break;
      case OBJECT_FIELD:
        chunks.push(journal.slice(at + FIELD.hash, 8), journal.slice(at + FIELD.payload, Number(size) - FIELD.payload));
        break;
      case OBJECT_ENTRY:
        chunks.push(journal.slice(at + ENTRY.seqnum, Number(size) - ENTRY.seqnum));
        break;
      case OBJECT_TAG:
        chunks.push(journal.slice(at + 16, 8), journal.slice(at + 24, 8));
        break;
      default:
        break;
    }
  }

  private seekState(goal: bigint, key: VerificationKey): void {
    const target = Number(goal);
    if (this.fsprgState !== null) {
      const epoch = epochOf(this.fsprgState);
      if (target === epoch) return;
      if (target === epoch + 1) {
        evolve(this.fsprgState);
        return;
      }
    }
    this.master ??= generateMasterKey(key.seed);
    this.fsprgState = seek(target, this.master, key.seed);
  }

  private hashPayload(at: number, offset: number, source: Uint8Array): { ok: true; hash: bigint; errno?: undefined } | { ok: false; errno: Errno; hash?: undefined } {
    const { journal } = this;
    const flags = journal.objectFlags(at) & OBJECT_COMPRESSED_MASK;
    if (flags !== 0 && flags !== 1 && flags !== 2 && flags !== 4) return { ok: false, errno: 'EBADMSG' };
    if (flags === 0) return { ok: true, hash: journal.hashData(source) };
    const result = journal.decompress(flags, source);
    if (!result.ok) {
      this.errorErrno(offset, result.errno, `${flags === 1 ? 'XZ' : flags === 2 ? 'LZ4' : 'ZSTD'} decompression failed`);
      return { ok: false, errno: result.errno };
    }
    return { ok: true, hash: journal.hashData(result.bytes) };
  }

  private objectVerify(offset: bigint, at: number): Errno | null {
    const { journal } = this;
    const type = journal.objectType(at);
    const flags = journal.objectFlags(at);
    const size = journal.objectSize(at);
    if ((flags & OBJECT_COMPRESSED_MASK) !== 0 && type !== OBJECT_DATA) {
      this.error(offset, `Found compressed object of type ${TYPE_NAMES[type] ?? 'unknown'} that isn't of type data, which is not allowed.`);
      return 'EBADMSG';
    }
    switch (type) {
      case OBJECT_DATA: {
        const entryOffset = journal.u64(at + DATA.entryOffset);
        const entries = journal.u64(at + DATA.nEntries);
        if (entryOffset === 0n) this.log.push(`${hex6(offset)}: Unused data (entry_offset==0)`);
        if ((entryOffset === 0n) !== (entries === 0n)) {
          this.error(offset, `Bad n_entries: ${entries}`);
          return 'EBADMSG';
        }
        const payloadOffset = journal.dataPayloadOffset;
        if (size - BigInt(payloadOffset) <= 0n) {
          this.error(offset, `Bad object size (<= ${payloadOffset}): ${size}`);
          return 'EBADMSG';
        }
        const stored = journal.slice(at + payloadOffset, Number(size) - payloadOffset);
        const hashed = this.hashPayload(at, Number(offset), stored);
        if (!hashed.ok) return hashed.errno;
        const recorded = journal.u64(at + DATA.hash);
        if (recorded !== hashed.hash) {
          this.error(offset, `Invalid hash (${recorded.toString(16).padStart(8, '0')} vs. ${hashed.hash.toString(16).padStart(8, '0')})`);
          return 'EBADMSG';
        }
        const next = [DATA.nextHashOffset, DATA.nextFieldOffset, DATA.entryOffset, DATA.entryArrayOffset].map((field) => journal.u64(at + field));
        if (!next.every(valid64)) {
          this.error(offset, `Invalid offset (next_hash_offset=${hex6(next[0])}, next_field_offset=${hex6(next[1])}, entry_offset=${hex6(next[2])}, entry_array_offset=${hex6(next[3])}`);
          return 'EBADMSG';
        }
        return null;
      }
      case OBJECT_FIELD: {
        if (size - 40n <= 0n) {
          this.error(offset, `Bad field size (<= 40): ${size}`);
          return 'EBADMSG';
        }
        const hashed = this.hashPayload(at, Number(offset), journal.slice(at + FIELD.payload, Number(size) - FIELD.payload));
        if (!hashed.ok) return hashed.errno;
        const recorded = journal.u64(at + FIELD.hash);
        if (recorded !== hashed.hash) {
          this.error(offset, `Invalid hash (${recorded.toString(16).padStart(8, '0')} vs. ${hashed.hash.toString(16).padStart(8, '0')})`);
          return 'EBADMSG';
        }
        const nextHash = journal.u64(at + FIELD.nextHashOffset);
        const head = journal.u64(at + FIELD.headDataOffset);
        if (!valid64(nextHash) || !valid64(head)) {
          this.error(offset, `Invalid offset (next_hash_offset=${hex6(nextHash)}, head_data_offset=${hex6(head)}`);
          return 'EBADMSG';
        }
        return null;
      }
      case OBJECT_ENTRY: {
        const itemSize = BigInt(journal.entryItemSize);
        if ((size - 64n) % itemSize !== 0n) {
          this.error(offset, `Bad entry size (<= 64): ${size}`);
          return 'EBADMSG';
        }
        if ((size - 64n) / itemSize <= 0n) {
          this.error(offset, `Invalid number items in entry: ${(size - 64n) / itemSize}`);
          return 'EBADMSG';
        }
        const seqnum = journal.u64(at + ENTRY.seqnum);
        if (seqnum <= 0n) {
          this.error(offset, `Invalid entry seqnum: ${seqnum.toString(16)}`);
          return 'EBADMSG';
        }
        const realtime = journal.u64(at + ENTRY.realtime);
        if (!validRealtime(realtime)) {
          this.error(offset, `Invalid entry realtime timestamp: ${realtime}`);
          return 'EBADMSG';
        }
        const monotonic = journal.u64(at + ENTRY.monotonic);
        if (!validMonotonic(monotonic)) {
          this.error(offset, `Invalid entry monotonic timestamp: ${monotonic}`);
          return 'EBADMSG';
        }
        const count = journal.entryItemCount(at);
        for (let index = 0n; index < count; index++) {
          const item = journal.entryItemOffset(at, Number(index));
          if (item === 0n || !valid64(item)) {
            this.error(offset, `Invalid entry item (${index}/${count}) offset: ${hex6(item)}`);
            return 'EBADMSG';
          }
        }
        return null;
      }
      case OBJECT_DATA_HASH_TABLE:
      case OBJECT_FIELD_HASH_TABLE: {
        const name = TYPE_NAMES[type];
        if ((size - 16n) % 16n !== 0n || (size - 16n) / 16n <= 0n) {
          this.error(offset, `Invalid ${name} size: ${size}`);
          return 'EBADMSG';
        }
        const count = journal.hashTableItemCount(at);
        for (let index = 0; BigInt(index) < count; index++) {
          const itemAt = at + 16 + index * 16;
          if (journal.lowHigh(itemAt) === 0 && journal.lowHigh(itemAt + 8) === 0) continue;
          const head = journal.u64(itemAt);
          const tail = journal.u64(itemAt + 8);
          if (head !== 0n && !valid64(head)) {
            this.error(offset, `Invalid ${name} hash table item (${index}/${count}) head_hash_offset: ${hex6(head)}`);
            return 'EBADMSG';
          }
          if (tail !== 0n && !valid64(tail)) {
            this.error(offset, `Invalid ${name} hash table item (${index}/${count}) tail_hash_offset: ${hex6(tail)}`);
            return 'EBADMSG';
          }
          if ((head !== 0n) !== (tail !== 0n)) {
            this.error(offset, `Invalid ${name} hash table item (${index}/${count}): head_hash_offset=${hex6(head)} tail_hash_offset=${hex6(tail)}`);
            return 'EBADMSG';
          }
        }
        return null;
      }
      case OBJECT_ENTRY_ARRAY: {
        const itemSize = BigInt(journal.entryArrayItemSize);
        if ((size - 24n) % itemSize !== 0n || (size - 24n) / itemSize <= 0n) {
          this.error(offset, `Invalid object entry array size: ${size}`);
          return 'EBADMSG';
        }
        const next = journal.u64(at + ENTRY_ARRAY.nextEntryArrayOffset);
        if (!valid64(next)) {
          this.error(offset, `Invalid object entry array next_entry_array_offset: ${hex6(next)}`);
          return 'EBADMSG';
        }
        const count = journal.entryArrayItemCount(at);
        for (let index = 0n; index < count; index++) {
          const item = journal.entryArrayItem(at, Number(index));
          if (item !== 0n && !valid64(item)) {
            this.error(offset, `Invalid object entry array item (${index}/${count}): ${hex6(item)}`);
            return 'EBADMSG';
          }
        }
        return null;
      }
      case OBJECT_TAG: {
        if (size !== 64n) {
          this.error(offset, `Invalid object tag size: ${size}`);
          return 'EBADMSG';
        }
        const epoch = journal.u64(at + 24);
        if (!validEpoch(epoch)) {
          this.error(offset, `Invalid object tag epoch: ${epoch}`);
          return 'EBADMSG';
        }
        return null;
      }
      default:
        return null;
    }
  }

  private verifyHashTable(at: number, p: bigint, seen: bigint, headerOffset: bigint, headerSize: bigint): void {
    const { journal } = this;
    const name = TYPE_NAMES[journal.objectType(at)];
    if (seen > 1n) {
      this.error(p, `More than one ${name}: ${seen}`);
      this.fail('EBADMSG');
    }
    if (headerOffset !== p + 16n) {
      this.error(p, `Header offset for ${name} invalid (${headerOffset} != ${p + 16n})`);
      this.fail('EBADMSG');
    }
    const actual = journal.objectSize(at) - 16n;
    if (headerSize !== actual) {
      this.error(p, `Header size for ${name} invalid (${headerSize} != ${actual})`);
      this.fail('EBADMSG');
    }
  }

  private contains(offsets: readonly bigint[], count: bigint, needle: bigint): boolean {
    let a = 0n;
    let b = count;
    while (a < b) {
      const c = (a + b) / 2n;
      const value = offsets[Number(c)];
      if (value === needle) return true;
      if (a + 1n >= b) return false;
      if (needle < value) b = c;
      else a = c;
    }
    return false;
  }

  private mapDataHashTable(): void {
    if (this.dataTableMapped) return;
    const error = this.journal.moveToRegion(this.journal.header(HEADER.dataHashTableOffset), this.journal.header(HEADER.dataHashTableSize));
    if (error !== null) {
      this.log.push(`Failed to map data hash table: ${strerror(error)}`);
      this.fail(error);
    }
    this.dataTableMapped = true;
  }

  private verifyEntryArray(): void {
    const { journal } = this;
    const count = journal.header(HEADER.nEntries);
    let a = journal.header(HEADER.entryArrayOffset);
    let index = 0n;
    let last = 0n;
    while (index < count) {
      if (a === 0n) {
        this.error(a, `Array chain too short at ${index} of ${count}`);
        this.fail('EBADMSG');
      }
      if (!this.contains(this.entryArrayOffsets, BigInt(this.entryArrayOffsets.length), a)) {
        this.error(a, `Invalid array ${index} of ${count}`);
        this.fail('EBADMSG');
      }
      let array = this.move(OBJECT_ENTRY_ARRAY, a);
      const next = journal.u64(array + ENTRY_ARRAY.nextEntryArrayOffset);
      if (next !== 0n && next <= a) {
        this.error(a, `Array chain has cycle at ${index} of ${count} (jumps back from to ${hex6(next)})`);
        this.fail('EBADMSG');
      }
      const capacity = journal.entryArrayItemCount(array);
      for (let slot = 0n; index < count && slot < capacity; index++, slot++) {
        const item = journal.entryArrayItem(array, Number(slot));
        if (item <= last) {
          this.error(a, `Entry array not sorted at ${index} of ${count}`);
          this.fail('EBADMSG');
        }
        last = item;
        if (!this.contains(this.entryOffsets, BigInt(this.entryOffsets.length), item)) {
          this.error(a, `Invalid array entry at ${index} of ${count}`);
          this.fail('EBADMSG');
        }
        const entry = this.move(OBJECT_ENTRY, item);
        this.verifyEntry(entry, item, index + 1n === count);
        array = this.move(OBJECT_ENTRY_ARRAY, a);
      }
      a = next;
    }
  }

  private verifyEntry(entry: number, p: bigint, last: boolean): void {
    const { journal } = this;
    const count = journal.entryItemCount(entry);
    for (let index = 0n; index < count; index++) {
      const q = journal.entryItemOffset(entry, Number(index));
      if (!this.contains(this.dataOffsets, BigInt(this.dataOffsets.length), q)) {
        this.error(p, 'Invalid data object of entry');
        this.fail('EBADMSG');
      }
      let data = this.move(OBJECT_DATA, q);
      if (!this.dataObjectInHashTable(journal.u64(data + DATA.hash), q)) {
        this.error(p, 'Data object missing from hash table');
        this.fail('EBADMSG');
      }
      data = this.move(OBJECT_DATA, q);
      const found = this.bisectForData(data, p, 'down');
      if (!found && !last) {
        this.error(p, `Entry object not referenced by linked data object at ${hex6(q)}`);
        this.fail('EBADMSG');
      }
    }
  }

  private dataObjectInHashTable(hash: bigint, p: bigint): boolean {
    const { journal } = this;
    const items = journal.header(HEADER.dataHashTableSize) / 16n;
    if (items <= 0n) return false;
    this.mapDataHashTable();
    const bucket = Number(journal.header(HEADER.dataHashTableOffset)) + Number(hash % items) * 16;
    let q = journal.u64(bucket);
    while (q !== 0n) {
      if (p === q) return true;
      const object = this.move(OBJECT_DATA, q);
      q = journal.u64(object + DATA.nextHashOffset);
    }
    return false;
  }

  private verifyData(data: number, p: bigint): void {
    const { journal } = this;
    const n = journal.u64(data + DATA.nEntries);
    let a = journal.u64(data + DATA.entryArrayOffset);
    if (a !== 0n && n < 2n) {
      this.error(p, `Entry array present (entry_array_offset=${hex6(a)}, but n_entries=${n})`);
      this.fail('EBADMSG');
    }
    if (n === 0n) return;
    let last = journal.u64(data + DATA.entryOffset);
    let q = last;
    if (!this.contains(this.entryOffsets, BigInt(this.entryOffsets.length), q)) {
      this.error(p, `Data object references invalid entry at ${hex6(q)}`);
      this.fail('EBADMSG');
    }
    if (!this.bisectByOffset(q)) {
      this.error(q, "Entry object doesn't exist in the main entry array");
      this.fail('EBADMSG');
    }
    let i = 1n;
    while (i < n) {
      if (a === 0n) {
        this.error(p, 'Array chain too short');
        this.fail('EBADMSG');
      }
      if (!this.contains(this.entryArrayOffsets, BigInt(this.entryArrayOffsets.length), a)) {
        this.error(p, `Invalid array offset ${hex6(a)}`);
        this.fail('EBADMSG');
      }
      let array = this.move(OBJECT_ENTRY_ARRAY, a);
      const next = journal.u64(array + ENTRY_ARRAY.nextEntryArrayOffset);
      if (next !== 0n && next <= a) {
        this.error(p, `Array chain has cycle (jumps back from ${hex6(a)} to ${hex6(next)})`);
        this.fail('EBADMSG');
      }
      const m = journal.entryArrayItemCount(array);
      for (let j = 0n; i < n && j < m; i++, j++) {
        q = journal.entryArrayItem(array, Number(j));
        if (q <= last) {
          this.error(p, `Data object's entry array not sorted (${q} <= ${last})`);
          this.fail('EBADMSG');
        }
        last = q;
        if (!this.contains(this.entryOffsets, BigInt(this.entryOffsets.length), q)) {
          this.error(p, `Data object references invalid entry at ${hex6(q)}`);
          this.fail('EBADMSG');
        }
        if (!this.bisectByOffset(q)) {
          this.error(q, "Entry object doesn't exist in the main entry array");
          this.fail('EBADMSG');
        }
        array = this.move(OBJECT_ENTRY_ARRAY, a);
      }
      a = next;
    }
  }

  private verifyDataHashTable(): void {
    const { journal } = this;
    const n = journal.header(HEADER.dataHashTableSize) / 16n;
    if (n <= 0n) return;
    this.mapDataHashTable();
    const base = Number(journal.header(HEADER.dataHashTableOffset));
    for (let i = 0n; i < n; i++) {
      const slot = base + Number(i) * 16;
      if (journal.lowHigh(slot) === 0 && journal.lowHigh(slot + 8) === 0) continue;
      let last = 0n;
      let p = journal.u64(slot);
      while (p !== 0n) {
        if (!this.contains(this.dataOffsets, BigInt(this.dataOffsets.length), p)) {
          this.error(p, `Invalid data object at hash entry ${i} of ${n}`);
          this.fail('EBADMSG');
        }
        const data = this.move(OBJECT_DATA, p);
        const next = journal.u64(data + DATA.nextHashOffset);
        if (next !== 0n && next <= p) {
          this.error(p, `Hash chain has a cycle in hash entry ${i} of ${n}`);
          this.fail('EBADMSG');
        }
        if (journal.u64(data + DATA.hash) % n !== i) {
          this.error(p, `Hash value mismatch in hash entry ${i} of ${n}`);
          this.fail('EBADMSG');
        }
        this.verifyData(data, p);
        last = p;
        p = next;
      }
      const tail = journal.u64(slot + 8);
      if (last !== tail) {
        this.error(p, `Tail hash pointer mismatch in hash table (${last} != ${tail})`);
        this.fail('EBADMSG');
      }
    }
  }

  private bisectByOffset(needle: bigint): boolean {
    const { journal } = this;
    return this.bisect(journal.header(HEADER.entryArrayOffset), journal.header(HEADER.nEntries), needle, 'down');
  }

  private bisectForData(data: number, needle: bigint, direction: Direction): boolean {
    const { journal } = this;
    let n = journal.u64(data + DATA.nEntries);
    if (n <= 0n) return false;
    n--;
    const extra = journal.u64(data + DATA.entryOffset);
    const first = journal.u64(data + DATA.entryArrayOffset);
    const outcome = testOffset(extra, needle);
    if (direction === 'down') {
      if (outcome === TEST_FOUND || outcome === TEST_RIGHT) return true;
    } else if (outcome === TEST_RIGHT) {
      return false;
    }
    if (this.bisect(first, n, needle, direction)) return true;
    return direction === 'up';
  }

  private chainPut(item: ChainCacheItem | undefined, first: bigint, array: bigint, begin: bigint, total: bigint, lastIndex: bigint): void {
    let cache = item;
    if (cache === undefined) {
      if (array === first) return;
      if (this.chainCache.size >= CHAIN_CACHE_MAX) {
        const oldest = this.chainCache.keys().next().value as bigint;
        this.chainCache.delete(oldest);
      }
      cache = { first, array, begin, total, lastIndex };
      this.chainCache.set(first, cache);
      return;
    }
    cache.array = array;
    cache.begin = begin;
    cache.total = total;
    cache.lastIndex = lastIndex;
  }

  private previousArray(offset: bigint, first: bigint): bigint {
    let p = first;
    let q = 0n;
    while (p > 0n && p !== offset) {
      const array = this.move(OBJECT_ENTRY_ARRAY, p);
      q = p;
      p = this.journal.u64(array + ENTRY_ARRAY.nextEntryArrayOffset);
    }
    if (p === 0n) this.fail('EBADMSG');
    return q;
  }

  private bisectStep(array: number, i: bigint, needle: bigint, direction: Direction, bounds: Bounds): number {
    const item = this.journal.entryArrayItem(array, Number(i));
    let outcome = item <= 0n ? CORRUPT : testOffset(item, needle);
    if (outcome === CORRUPT) {
      if (i === bounds.left) return TEST_GOTO_PREVIOUS;
      bounds.m = i;
      bounds.right = i - 1n;
      return TEST_RIGHT;
    }
    if (outcome === TEST_FOUND) outcome = direction === 'down' ? TEST_RIGHT : TEST_LEFT;
    if (outcome === TEST_RIGHT) {
      if (direction === 'down') bounds.right = i;
      else {
        if (i === 0n) return TEST_GOTO_PREVIOUS;
        bounds.right = i - 1n;
      }
    } else if (direction === 'down') {
      if (i === bounds.m - 1n) return TEST_GOTO_NEXT;
      bounds.left = i + 1n;
    } else {
      bounds.left = i;
    }
    return outcome;
  }

  private bisect(first: bigint, total: bigint, needle: bigint, direction: Direction): boolean {
    const { journal } = this;
    let n = total;
    if (n <= 0n) return false;
    let a = first;
    let t = 0n;
    let lastIndex = UINT64_NONE;
    const cached = this.chainCache.get(first);
    if (cached !== undefined && n > cached.total && cached.begin !== 0n && testOffset(cached.begin, needle) === TEST_LEFT) {
      a = cached.array;
      n -= cached.total;
      t = cached.total;
      lastIndex = cached.lastIndex;
    }
    let array = 0;
    let index = 0n;
    let previous = false;
    search: while (a > 0n) {
      array = this.move(OBJECT_ENTRY_ARRAY, a);
      const k = journal.entryArrayItemCount(array);
      const original = k < n ? k : n;
      const bounds: Bounds = { m: original, left: 0n, right: original - 1n };
      if (bounds.m <= 0n) return false;
      if (direction === 'up' && this.bisectStep(array, 0n, needle, direction, bounds) === TEST_GOTO_PREVIOUS) {
        previous = true;
        break;
      }
      let outcome = this.bisectStep(array, bounds.right, needle, direction, bounds);
      if (outcome === TEST_GOTO_PREVIOUS) {
        previous = true;
        break;
      }
      if (outcome === TEST_RIGHT) {
        if (lastIndex > 0n && bounds.left < lastIndex - 1n && lastIndex - 1n < bounds.right) {
          outcome = this.bisectStep(array, lastIndex - 1n, needle, direction, bounds);
          if (outcome === TEST_GOTO_PREVIOUS) {
            previous = true;
            break;
          }
        }
        if (lastIndex < UINT64_NONE && bounds.left < lastIndex + 1n && lastIndex + 1n < bounds.right) {
          outcome = this.bisectStep(array, lastIndex + 1n, needle, direction, bounds);
          if (outcome === TEST_GOTO_PREVIOUS) {
            previous = true;
            break;
          }
        }
        for (;;) {
          if (bounds.left === bounds.right) {
            if (bounds.m !== original && direction === 'down') {
              outcome = this.bisectStep(array, bounds.left, needle, direction, bounds);
              if (outcome === TEST_GOTO_PREVIOUS || outcome === TEST_GOTO_NEXT) return false;
            }
            index = bounds.left;
            break search;
          }
          index = (bounds.left + bounds.right + (direction === 'up' ? 1n : 0n)) / 2n;
          outcome = this.bisectStep(array, index, needle, direction, bounds);
          if (outcome === TEST_GOTO_PREVIOUS) {
            previous = true;
            break search;
          }
          if (outcome === TEST_GOTO_NEXT) return false;
        }
      }
      if (k >= n) {
        if (direction === 'up') {
          index = n - 1n;
          break;
        }
        return false;
      }
      n -= k;
      t += k;
      lastIndex = UINT64_NONE;
      a = journal.u64(array + ENTRY_ARRAY.nextEntryArrayOffset);
    }
    if (a <= 0n) return false;
    if (previous) {
      if (t === 0n || direction === 'down') return false;
      index = UINT64_NONE;
    }
    const begin = journal.entryArrayItem(array, 0);
    if (begin <= 0n) this.fail('EBADMSG');
    this.chainPut(cached, first, a, begin, t, index);
    if (index === UINT64_NONE) {
      const before = this.previousArray(a, first);
      if (before <= 0n) return false;
      array = this.move(OBJECT_ENTRY_ARRAY, before);
      const m = journal.entryArrayItemCount(array);
      if (m === 0n || t < m) this.fail('EBADMSG');
      index = m - 1n;
    }
    if (journal.entryArrayItem(array, Number(index)) === 0n) this.fail('EBADMSG');
    return true;
  }
}
