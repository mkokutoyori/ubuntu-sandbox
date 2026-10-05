import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { resourceRecordToLegacyRecord } from '@/network/dns/compat/DnsWireCompat';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';

export type DnsCacheLookup =
  | {
      readonly kind: 'hit';
      readonly records: readonly ResourceRecord<ResourceRecordData>[];
      readonly security?: DnssecStatus;
    }
  | { readonly kind: 'negative'; readonly rcode: number }
  | { readonly kind: 'servfail' }
  | { readonly kind: 'miss' };

interface PositiveEntry {
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly storedAtMs: number;
  readonly entry: string;
  readonly security?: DnssecStatus;
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

const ANY_TYPE_KEY = '*';

function nameErrorKeyOf(name: string): string {
  return `${name.toLowerCase().replace(/\.$/, '')}|${ANY_TYPE_KEY}`;
}

const MAX_SERVFAIL_TTL_SECONDS = 300;

export class DnsCache {
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly negative = new Map<string, NegativeEntry>();
  private readonly servfail = new Map<string, { readonly expiresAtMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  storePositive(
    records: readonly ResourceRecord<ResourceRecordData>[], qname?: string, security?: DnssecStatus,
  ): void {
    const storedAtMs = this.now();
    const grouped = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of records) {
      const key = keyOf(rr.name, rr.data.type);
      const set = grouped.get(key);
      if (set) set.push(rr);
      else grouped.set(key, [rr]);
    }
    for (const [key, set] of grouped) {
      this.positive.set(key, { records: set, storedAtMs, entry: qname ?? set[0].name, security });
      this.negative.delete(key);
      this.negative.delete(nameErrorKeyOf(set[0].name));
    }
  }

  storeNegative(qname: string, qtype: number, rcode: number, soa: ResourceRecord<SoaRecordData>): void {
    const ttlSeconds = Math.min(soa.ttl, soa.data.minimum);
    const key = rcode === DnsRcode.NXDOMAIN ? nameErrorKeyOf(qname) : keyOf(qname, qtype);
    this.negative.set(key, { rcode, ttlSeconds, storedAtMs: this.now(), entry: qname, qtype });
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

    const failure = this.servfail.get(key);
    if (failure) {
      if (nowMs < failure.expiresAtMs) return { kind: 'servfail' };
      this.servfail.delete(key);
    }

    for (const negativeKey of [nameErrorKeyOf(qname), key]) {
      const negativeEntry = this.negative.get(negativeKey);
      if (!negativeEntry) continue;
      const elapsed = (nowMs - negativeEntry.storedAtMs) / 1000;
      if (elapsed <= negativeEntry.ttlSeconds) {
        return { kind: 'negative', rcode: negativeEntry.rcode };
      }
      this.negative.delete(negativeKey);
    }

    const positiveEntry = this.positive.get(key);
    if (positiveEntry) {
      const elapsedSeconds = Math.floor((nowMs - positiveEntry.storedAtMs) / 1000);
      const decayed = positiveEntry.records
        .map((rr) => ({ ...rr, ttl: rr.ttl - elapsedSeconds }))
        .filter((rr) => rr.ttl > 0);
      if (decayed.length > 0) {
        return { kind: 'hit', records: decayed, security: positiveEntry.security };
      }
      this.positive.delete(key);
    }

    return { kind: 'miss' };
  }

  storeServfail(qname: string, qtype: number, ttlSeconds: number): void {
    const bounded = Math.min(Math.max(ttlSeconds, 0), MAX_SERVFAIL_TTL_SECONDS);
    if (bounded === 0) return;
    this.servfail.set(keyOf(qname, qtype), { expiresAtMs: this.now() + bounded * 1000 });
  }

  forget(name: string): void {
    const prefix = `${name.toLowerCase().replace(/\.$/, '')}|`;
    for (const store of [this.positive, this.negative, this.servfail]) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    }
  }

  flush(): void {
    this.positive.clear();
    this.negative.clear();
    this.servfail.clear();
  }
}
