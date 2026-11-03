import { simulationNowMs } from '@/network/core/SystemClock';

import type { IPAddress } from '@/network/core/types';
import type { ARecordData, CnameRecordData, NsRecordData, ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';
import { MAX_CNAME_CHAIN_DEPTH } from '@/network/dns/zone/Zone';
import { resourceRecordToLegacyRecord } from '@/network/dns/compat/DnsWireCompat';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeCanonicalRData } from '@/network/dns/wire/DnsMessageCodec';

export type DnsCacheLookup =
  | {
      readonly kind: 'hit';
      readonly records: readonly ResourceRecord<ResourceRecordData>[];
      readonly security?: DnssecStatus;
    }
  | {
      readonly kind: 'negative';
      readonly rcode: number;
      readonly soa: ResourceRecord<SoaRecordData>;
      readonly aliases?: readonly ResourceRecord<ResourceRecordData>[];
    }
  | { readonly kind: 'servfail' }
  | { readonly kind: 'miss' };

export type DnsTrust = 'additional' | 'glue' | 'answer' | 'authauthority' | 'authanswer';

interface PositiveEntry {
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly storedAtMs: number;
  readonly entry: string;
  readonly security?: DnssecStatus;
  readonly trust: DnsTrust;
}

export interface CachedRecordSet {
  readonly name: string;
  readonly type: number;
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly trust: DnsTrust;
  readonly storedAtMs: number;
}

export interface CachedNegative {
  readonly name: string;
  readonly coveredType: number;
  readonly rcode: number;
  readonly ttl: number;
  readonly soa: ResourceRecord<SoaRecordData>;
  readonly storedAtMs: number;
}

export interface DnsCacheSnapshot {
  readonly recordSets: readonly CachedRecordSet[];
  readonly negatives: readonly CachedNegative[];
  readonly delegations: readonly (DelegationView & { readonly storedAtMs: number })[];
}

interface NegativeEntry {
  readonly rcode: number;
  readonly ttlSeconds: number;
  readonly storedAtMs: number;
  readonly entry: string;
  readonly qtype: number;
  readonly soa: ResourceRecord<SoaRecordData>;
}

interface DelegationEntry {
  readonly zone: string;
  readonly nameServers: readonly ResourceRecord<NsRecordData>[];
  readonly addresses: readonly ResourceRecord<ARecordData>[];
  readonly storedAtMs: number;
}

export interface DelegationView {
  readonly zone: string;
  readonly nameServers: readonly ResourceRecord<NsRecordData>[];
  readonly addresses: readonly ResourceRecord<ARecordData>[];
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
const MISS: DnsCacheLookup = { kind: 'miss' };

function combinedSecurity(parts: readonly (DnssecStatus | undefined)[]): DnssecStatus | undefined {
  if (parts.some((part) => part === undefined)) return undefined;
  return parts.every((part) => part === parts[0]) ? parts[0] : 'insecure';
}

const RECORD_FIXED_BYTES = 10;
const PERCENT = 100;

export interface DnsCacheLimits {
  readonly maxTtlSeconds: number | null;
  readonly maxNegativeTtlSeconds: number | null;
  readonly lockingPercent: number;
  readonly storeEmptyAuthoritative: boolean;
  readonly maxBytes: number | null;
  readonly admitsUnrelatedRecords: boolean;
}

export const DEFAULT_CACHE_LIMITS: DnsCacheLimits = {
  maxTtlSeconds: null, maxNegativeTtlSeconds: null, lockingPercent: 0, storeEmptyAuthoritative: true,
  maxBytes: null, admitsUnrelatedRecords: false,
};

function recordBytes(rr: ResourceRecord<ResourceRecordData>): number {
  return rr.name.length + RECORD_FIXED_BYTES + encodeCanonicalRData(rr.data).length;
}

export class DnsCache {
  private readonly positive = new Map<string, PositiveEntry>();
  private readonly negative = new Map<string, NegativeEntry>();
  private readonly servfail = new Map<string, { readonly expiresAtMs: number }>();
  private readonly delegationEntries = new Map<string, DelegationEntry>();

  constructor(
    private readonly now: () => number = simulationNowMs,
    private readonly limits: () => DnsCacheLimits = () => DEFAULT_CACHE_LIMITS,
  ) {}

  storePositive(
    records: readonly ResourceRecord<ResourceRecordData>[], qname?: string, security?: DnssecStatus, trust: DnsTrust = 'authanswer',
  ): void {
    const storedAtMs = this.now();
    const { maxTtlSeconds, lockingPercent } = this.limits();
    if (maxTtlSeconds === 0) return;
    const grouped = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of records) {
      const key = keyOf(rr.name, rr.data.type);
      const capped = maxTtlSeconds === null || rr.ttl <= maxTtlSeconds ? rr : { ...rr, ttl: maxTtlSeconds };
      const set = grouped.get(key);
      if (set) set.push(capped);
      else grouped.set(key, [capped]);
    }
    for (const [key, set] of grouped) {
      if (this.isLocked(key, storedAtMs, lockingPercent)) continue;
      this.positive.set(key, { records: set, storedAtMs, entry: qname ?? set[0].name, security, trust });
      this.negative.delete(key);
      this.negative.delete(nameErrorKeyOf(set[0].name));
    }
    this.evictToFit();
  }

  storeNegative(qname: string, qtype: number, rcode: number, soa: ResourceRecord<SoaRecordData>): void {
    const { maxNegativeTtlSeconds, storeEmptyAuthoritative } = this.limits();
    if (rcode === DnsRcode.NOERROR && !storeEmptyAuthoritative) return;
    const advertised = Math.min(soa.ttl, soa.data.minimum);
    const ttlSeconds = maxNegativeTtlSeconds === null ? advertised : Math.min(advertised, maxNegativeTtlSeconds);
    if (ttlSeconds <= 0) return;
    const key = rcode === DnsRcode.NXDOMAIN ? nameErrorKeyOf(qname) : keyOf(qname, qtype);
    this.negative.set(key, { rcode, ttlSeconds, storedAtMs: this.now(), entry: qname, qtype, soa });
  }

  admitsUnrelatedRecords(): boolean {
    return this.limits().admitsUnrelatedRecords;
  }

  enforceLimits(): void {
    this.evictToFit();
  }

  private isLocked(key: string, nowMs: number, lockingPercent: number): boolean {
    const held = this.positive.get(key);
    if (held === undefined || lockingPercent <= 0) return false;
    const lifetimeMs = Math.max(...held.records.map((rr) => rr.ttl)) * 1000;
    return nowMs - held.storedAtMs < lifetimeMs * Math.min(lockingPercent, PERCENT) / PERCENT;
  }

  private evictToFit(): void {
    const { maxBytes } = this.limits();
    if (maxBytes === null) return;
    const sized = [...this.positive].map(([key, entry]) => ({
      key, storedAtMs: entry.storedAtMs, bytes: entry.records.reduce((total, rr) => total + recordBytes(rr), 0),
    }));
    let total = sized.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of sized.sort((a, b) => a.storedAtMs - b.storedAtMs)) {
      if (total <= maxBytes) return;
      this.positive.delete(item.key);
      total -= item.bytes;
    }
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

  snapshot(): DnsCacheSnapshot {
    const nowMs = this.now();
    const recordSets: CachedRecordSet[] = [];
    for (const [key, held] of [...this.positive]) {
      const elapsedSeconds = Math.floor((nowMs - held.storedAtMs) / 1000);
      const live = held.records.map((rr) => ({ ...rr, ttl: rr.ttl - elapsedSeconds })).filter((rr) => rr.ttl > 0);
      if (live.length === 0) {
        this.positive.delete(key);
        continue;
      }
      recordSets.push({ name: live[0].name, type: live[0].data.type, records: live, trust: held.trust, storedAtMs: held.storedAtMs });
    }
    const negatives: CachedNegative[] = [];
    for (const [key, held] of [...this.negative]) {
      const ttl = held.ttlSeconds - Math.floor((nowMs - held.storedAtMs) / 1000);
      if (ttl <= 0) {
        this.negative.delete(key);
        continue;
      }
      const nameError = held.rcode === DnsRcode.NXDOMAIN;
      negatives.push({
        name: held.entry, coveredType: nameError ? RRType.ANY : held.qtype, rcode: held.rcode, ttl,
        soa: { ...held.soa, ttl }, storedAtMs: held.storedAtMs,
      });
    }
    const delegations = [...this.delegationEntries.keys()].flatMap((zone) => {
      const live = this.liveDelegation(zone);
      return live === null ? [] : [{ ...live, storedAtMs: this.delegationEntries.get(zone)!.storedAtMs }];
    });
    return { recordSets, negatives, delegations };
  }

  size(): number {
    return this.entries().length;
  }

  lookup(qname: string, qtype: number): DnsCacheLookup {
    const direct = this.lookupOwnRecords(qname, qtype);
    if (direct.kind !== 'miss' || qtype === RRType.CNAME || qtype === RRType.ANY) return direct;
    return this.lookupThroughAliases(qname, qtype);
  }

  private lookupThroughAliases(qname: string, qtype: number): DnsCacheLookup {
    const aliases: ResourceRecord<ResourceRecordData>[] = [];
    const securities: (DnssecStatus | undefined)[] = [];
    const visited = new Set<string>();
    let name = qname;
    while (aliases.length < MAX_CNAME_CHAIN_DEPTH && !visited.has(keyOf(name, qtype))) {
      visited.add(keyOf(name, qtype));
      const alias = this.lookupOwnRecords(name, RRType.CNAME);
      if (alias.kind !== 'hit') return MISS;
      aliases.push(...alias.records);
      securities.push(alias.security);
      name = (alias.records[0].data as CnameRecordData).cname;
      const target = this.lookupOwnRecords(name, qtype);
      if (target.kind === 'hit') {
        return { kind: 'hit', records: [...aliases, ...target.records], security: combinedSecurity([...securities, target.security]) };
      }
      if (target.kind === 'negative') return { ...target, aliases: [...aliases] };
      if (target.kind !== 'miss') return MISS;
    }
    return MISS;
  }

  private lookupOwnRecords(qname: string, qtype: number): DnsCacheLookup {
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
        const remaining = Math.max(0, negativeEntry.ttlSeconds - Math.floor(elapsed));
        return { kind: 'negative', rcode: negativeEntry.rcode, soa: { ...negativeEntry.soa, ttl: remaining } };
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

    return MISS;
  }

  storeDelegation(
    zone: string,
    nameServers: readonly ResourceRecord<NsRecordData>[],
    addresses: readonly ResourceRecord<ARecordData>[],
  ): void {
    const { maxTtlSeconds } = this.limits();
    if (maxTtlSeconds === 0 || nameServers.length === 0 || addresses.length === 0) return;
    const capped = <T extends ResourceRecordData>(rr: ResourceRecord<T>): ResourceRecord<T> =>
      maxTtlSeconds === null || rr.ttl <= maxTtlSeconds ? rr : { ...rr, ttl: maxTtlSeconds };
    const key = normalizeDnsName(zone);
    this.delegationEntries.set(key, {
      zone: key, nameServers: nameServers.map(capped), addresses: addresses.map(capped), storedAtMs: this.now(),
    });
  }

  closestDelegation(qname: string, parentOnly: boolean): { readonly zone: string; readonly servers: IPAddress[] } | null {
    let name: string | null = normalizeDnsName(qname);
    if (parentOnly) name = parentName(name);
    while (name !== null && name !== '') {
      const live = this.liveDelegation(name);
      if (live !== null) return { zone: name, servers: live.addresses.map((rr) => rr.data.address) };
      name = parentName(name);
    }
    return null;
  }

  glueAddresses(name: string): ResourceRecord<ARecordData>[] {
    const wanted = normalizeDnsName(name);
    for (const zone of [...this.delegationEntries.keys()]) {
      const live = this.liveDelegation(zone);
      const matching = live?.addresses.filter((rr) => normalizeDnsName(rr.name) === wanted) ?? [];
      if (matching.length > 0) return matching;
    }
    return [];
  }

  forgetDelegation(zone: string): void {
    this.delegationEntries.delete(normalizeDnsName(zone));
  }

  delegations(): DelegationView[] {
    const views: DelegationView[] = [];
    for (const zone of [...this.delegationEntries.keys()]) {
      const live = this.liveDelegation(zone);
      if (live !== null) views.push(live);
    }
    return views;
  }

  private liveDelegation(zone: string): DelegationView | null {
    const held = this.delegationEntries.get(zone);
    if (held === undefined) return null;
    const elapsedSeconds = Math.floor((this.now() - held.storedAtMs) / 1000);
    const decay = <T extends ResourceRecordData>(rr: ResourceRecord<T>): ResourceRecord<T> => ({ ...rr, ttl: rr.ttl - elapsedSeconds });
    const nameServers = held.nameServers.map(decay).filter((rr) => rr.ttl > 0);
    const addresses = held.addresses.map(decay).filter((rr) => rr.ttl > 0);
    if (nameServers.length === 0 || addresses.length === 0) {
      this.delegationEntries.delete(zone);
      return null;
    }
    return { zone, nameServers, addresses };
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
    this.delegationEntries.clear();
  }
}
