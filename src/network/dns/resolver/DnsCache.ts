import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { resourceRecordToLegacyRecord } from '@/network/dns/compat/DnsWireCompat';

export type DnsCacheLookup =
  | { readonly kind: 'hit'; readonly records: readonly ResourceRecord<ResourceRecordData>[] }
  | { readonly kind: 'negative'; readonly rcode: number }
  | { readonly kind: 'miss' };

interface PositiveEntry {
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly storedAtMs: number;
  readonly entry: string;
}

interface NegativeEntry {
  readonly rcode: number;
  readonly ttlSeconds: number;
  readonly storedAtMs: number;
  readonly entry: string;
  readonly qtype: number;
}

export interface DnsCacheRecordView {
  readonly entry: string;
  readonly name: string;
  readonly type: string;
  readonly typeNumber: number;
  readonly ttl: number;
  readonly data: string;
  readonly negative: boolean;
  readonly rcode?: number;
}

function keyOf(name: string, type: number): string {
  return `${name.toLowerCase().replace(/\.$/, '')}|${type}`;
}

export class DnsCache {
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly negative = new Map<string, NegativeEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  storePositive(records: readonly ResourceRecord<ResourceRecordData>[], qname?: string): void {
    const storedAtMs = this.now();
    const grouped = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of records) {
      const key = keyOf(rr.name, rr.data.type);
      const set = grouped.get(key);
      if (set) set.push(rr);
      else grouped.set(key, [rr]);
    }
    for (const [key, set] of grouped) {
      this.positive.set(key, { records: set, storedAtMs, entry: qname ?? set[0].name });
      this.negative.delete(key);
    }
  }

  storeNegative(qname: string, qtype: number, rcode: number, soa: ResourceRecord<SoaRecordData>): void {
    const ttlSeconds = Math.min(soa.ttl, soa.data.minimum);
    this.negative.set(keyOf(qname, qtype),
      { rcode, ttlSeconds, storedAtMs: this.now(), entry: qname, qtype });
  }

  entries(): DnsCacheRecordView[] {
    const nowMs = this.now();
    const out: DnsCacheRecordView[] = [];
    for (const [key, entry] of [...this.positive]) {
      const elapsedSeconds = Math.floor((nowMs - entry.storedAtMs) / 1000);
      const live = entry.records
        .map(rr => ({ rr, ttl: rr.ttl - elapsedSeconds }))
        .filter(x => x.ttl > 0);
      if (live.length === 0) { this.positive.delete(key); continue; }
      for (const { rr, ttl } of live) {
        const legacy = resourceRecordToLegacyRecord(rr);
        if (!legacy) continue;
        out.push({
          entry: entry.entry, name: rr.name, type: legacy.type,
          typeNumber: rr.data.type, ttl, data: legacy.value, negative: false,
        });
      }
    }
    for (const [key, entry] of [...this.negative]) {
      const elapsedSeconds = Math.floor((nowMs - entry.storedAtMs) / 1000);
      const ttl = entry.ttlSeconds - elapsedSeconds;
      if (ttl <= 0) { this.negative.delete(key); continue; }
      out.push({
        entry: entry.entry, name: entry.entry, type: '', typeNumber: entry.qtype,
        ttl, data: '', negative: true, rcode: entry.rcode,
      });
    }
    return out;
  }

  size(): number {
    return this.entries().length;
  }

  lookup(qname: string, qtype: number): DnsCacheLookup {
    const key = keyOf(qname, qtype);
    const nowMs = this.now();

    const negativeEntry = this.negative.get(key);
    if (negativeEntry) {
      const elapsed = (nowMs - negativeEntry.storedAtMs) / 1000;
      if (elapsed <= negativeEntry.ttlSeconds) {
        return { kind: 'negative', rcode: negativeEntry.rcode };
      }
      this.negative.delete(key);
    }

    const positiveEntry = this.positive.get(key);
    if (positiveEntry) {
      const elapsedSeconds = Math.floor((nowMs - positiveEntry.storedAtMs) / 1000);
      const decayed = positiveEntry.records
        .map((rr) => ({ ...rr, ttl: rr.ttl - elapsedSeconds }))
        .filter((rr) => rr.ttl > 0);
      if (decayed.length > 0) {
        return { kind: 'hit', records: decayed };
      }
      this.positive.delete(key);
    }

    return { kind: 'miss' };
  }

  flush(): void {
    this.positive.clear();
    this.negative.clear();
  }
}
