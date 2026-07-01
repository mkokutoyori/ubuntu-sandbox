import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';

export type DnsCacheLookup =
  | { readonly kind: 'hit'; readonly records: readonly ResourceRecord<ResourceRecordData>[] }
  | { readonly kind: 'negative'; readonly rcode: number }
  | { readonly kind: 'miss' };

interface PositiveEntry {
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly storedAtMs: number;
}

interface NegativeEntry {
  readonly rcode: number;
  readonly ttlSeconds: number;
  readonly storedAtMs: number;
}

function keyOf(name: string, type: number): string {
  return `${name.toLowerCase().replace(/\.$/, '')}|${type}`;
}

export class DnsCache {
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly negative = new Map<string, NegativeEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  storePositive(records: readonly ResourceRecord<ResourceRecordData>[]): void {
    const storedAtMs = this.now();
    const grouped = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of records) {
      const key = keyOf(rr.name, rr.data.type);
      const set = grouped.get(key);
      if (set) set.push(rr);
      else grouped.set(key, [rr]);
    }
    for (const [key, set] of grouped) {
      this.positive.set(key, { records: set, storedAtMs });
      this.negative.delete(key);
    }
  }

  storeNegative(qname: string, qtype: number, rcode: number, soa: ResourceRecord<SoaRecordData>): void {
    const ttlSeconds = Math.min(soa.ttl, soa.data.minimum);
    this.negative.set(keyOf(qname, qtype), { rcode, ttlSeconds, storedAtMs: this.now() });
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
}
