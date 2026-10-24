import { hmac } from '@/crypto/mac/hmac';
import { SHA256 } from '@/crypto/hash/sha256';
import { epochOf, evolve, stateKey } from './Fsprg';

export const OBJECT_DATA = 1;
export const OBJECT_FIELD = 2;
export const OBJECT_ENTRY = 3;
export const OBJECT_DATA_HASH_TABLE = 4;
export const OBJECT_FIELD_HASH_TABLE = 5;
export const OBJECT_ENTRY_ARRAY = 6;
export const OBJECT_TAG = 7;
export const TAG_OBJECT_SIZE = 64;
export const TAG_LENGTH = 32;

export interface SealKey {
  readonly startUsec: number;
  readonly intervalUsec: number;
  readonly state: Uint8Array;
  persist(): void;
}

export interface TagRecord {
  readonly offset: number;
  readonly seqnum: number;
  readonly epoch: number;
  readonly tag: Uint8Array;
  readonly stream: readonly Uint8Array[];
  readonly headerIndex: number | null;
  readonly lastEntryRealtime: number | null;
  readonly maxEntryRealtime: number;
  readonly minEntryRealtime: number;
}

export function littleEndian(value: number | bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = BigInt(value);
  for (let index = 0; index < length; index++) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function objectHeader(type: number, size: number): Uint8Array {
  const out = new Uint8Array(16);
  out[0] = type;
  out.set(littleEndian(size, 8), 8);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function tagKey(state: Uint8Array): Uint8Array {
  return stateKey(state, TAG_LENGTH, 0);
}

export function tagValue(key: Uint8Array, stream: readonly Uint8Array[]): Uint8Array {
  return hmac(SHA256, key, concatBytes(stream));
}

export function epochFor(realtimeUsec: number, key: Pick<SealKey, 'startUsec' | 'intervalUsec'>): number | null {
  if (key.startUsec === 0 || key.intervalUsec === 0 || realtimeUsec < key.startUsec) return null;
  return Math.floor((realtimeUsec - key.startUsec) / key.intervalUsec);
}

export class SealChain {
  readonly tags: TagRecord[] = [];
  private pending: Uint8Array[] = [];
  private pendingHeaderIndex: number | null = null;
  private lastEntryRealtime: number | null = null;
  private maxEntryRealtime = 0;
  private minEntryRealtime = Number.POSITIVE_INFINITY;

  constructor(readonly key: SealKey, private readonly allocateTag: () => number) {}

  get tagCount(): number {
    return this.tags.length;
  }

  get currentEpoch(): number {
    return epochOf(this.key.state);
  }

  put(...chunks: Uint8Array[]): void {
    for (const chunk of chunks) this.pending.push(chunk);
  }

  putHeader(chunk: Uint8Array): void {
    this.pendingHeaderIndex = this.pending.length;
    this.pending.push(chunk);
  }

  noteEntry(realtimeUsec: number): void {
    this.lastEntryRealtime = realtimeUsec;
    this.maxEntryRealtime = Math.max(this.maxEntryRealtime, realtimeUsec);
    this.minEntryRealtime = Math.min(this.minEntryRealtime, realtimeUsec);
  }

  appendTag(): void {
    const offset = this.allocateTag();
    const seqnum = this.tags.length + 1;
    const epoch = this.currentEpoch;
    this.put(objectHeader(OBJECT_TAG, TAG_OBJECT_SIZE), littleEndian(seqnum, 8), littleEndian(epoch, 8));
    const stream = this.pending;
    const headerIndex = this.pendingHeaderIndex;
    this.pending = [];
    this.pendingHeaderIndex = null;
    this.tags.push({
      offset, seqnum, epoch, tag: tagValue(tagKey(this.key.state), stream), stream, headerIndex,
      lastEntryRealtime: this.lastEntryRealtime, maxEntryRealtime: this.maxEntryRealtime, minEntryRealtime: this.minEntryRealtime,
    });
    this.minEntryRealtime = Number.POSITIVE_INFINITY;
  }

  maybeAppendTag(realtimeUsec: number): void {
    const goal = epochFor(realtimeUsec, this.key);
    if (goal === null || this.currentEpoch > goal || this.currentEpoch === goal) return;
    this.appendTag();
    let epoch = this.currentEpoch;
    while (epoch < goal) {
      evolve(this.key.state);
      epoch = this.currentEpoch;
      if (epoch < goal) this.appendTag();
    }
    this.key.persist();
  }
}
