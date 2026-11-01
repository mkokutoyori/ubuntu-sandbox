/*
 * Structure — the limits a DnsCache can be given: a TTL ceiling, a negative TTL ceiling, cache locking, whether empty
 * authoritative answers are kept, a size ceiling in bytes, and whether records unrelated to the question are admitted.
 * A cache built without limits behaves as before. Discrimination (run on the tree before the change): 8 of the 10 cases
 * fall (the constructor took no limits); the two that pass either way are NON-REGRESSIONS (a cache with no limits keeps
 * the advertised TTL and overwrites freely; a lock of 100 percent ends with the TTL).
 */
import { describe, it, expect } from 'vitest';
import { DnsCache, DEFAULT_CACHE_LIMITS, type DnsCacheLimits } from '@/network/dns/resolver/DnsCache';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';

const START = 1_700_000_000_000;

function cacheWith(initial: Partial<DnsCacheLimits>) {
  const clock = { now: START };
  let limits = initial;
  const cache = new DnsCache(() => clock.now, () => ({ ...DEFAULT_CACHE_LIMITS, ...limits }));
  const change = (next: Partial<DnsCacheLimits>): void => { limits = next; };
  return { cache, clock, change };
}

const soa = (ttl: number, minimum: number): ResourceRecord<SoaRecordData> => ({
  name: 'lab.test', class: 1, ttl,
  data: { type: RRType.SOA, mname: 'ns.lab.test', rname: 'hostmaster.lab.test', serial: 1, refresh: 900, retry: 600, expire: 86400, minimum },
} as unknown as ResourceRecord<SoaRecordData>);

describe('a cache with no limits', () => {
  it('NON-REGRESSION: keeps the advertised TTL and overwrites freely', () => {
    const { cache } = cacheWith({});
    cache.storePositive([makeARecord('a.lab.test', 86400 * 30, '10.0.0.1')]);
    cache.storePositive([makeARecord('a.lab.test', 60, '10.0.0.2')]);
    const hit = cache.lookup('a.lab.test', RRType.A);
    expect(hit.kind === 'hit' && hit.records.map((rr) => rr.ttl)).toEqual([60]);
  });
});

describe('TTL ceilings', () => {
  it('caps a positive TTL', () => {
    const { cache } = cacheWith({ maxTtlSeconds: 600 });
    cache.storePositive([makeARecord('a.lab.test', 3600, '10.0.0.1')]);
    const hit = cache.lookup('a.lab.test', RRType.A);
    expect(hit.kind === 'hit' && hit.records[0].ttl).toBe(600);
  });

  it('a zero ceiling stores nothing', () => {
    const { cache } = cacheWith({ maxTtlSeconds: 0 });
    cache.storePositive([makeARecord('a.lab.test', 3600, '10.0.0.1')]);
    expect(cache.lookup('a.lab.test', RRType.A).kind).toBe('miss');
  });

  it('a zero ceiling leaves what is already cached alone', () => {
    const { cache, change } = cacheWith({});
    cache.storePositive([makeARecord('a.lab.test', 3600, '10.0.0.1')]);
    change({ maxTtlSeconds: 0 });
    cache.storePositive([makeARecord('a.lab.test', 3600, '10.0.0.2')]);
    const hit = cache.lookup('a.lab.test', RRType.A);
    expect(hit.kind === 'hit' && String((hit.records[0].data as { address: unknown }).address)).toBe('10.0.0.1');
  });

  it('caps a negative TTL', () => {
    const { cache, clock } = cacheWith({ maxNegativeTtlSeconds: 60 });
    cache.storeNegative('x.lab.test', RRType.A, DnsRcode.NXDOMAIN, soa(3600, 3600));
    clock.now += 59_000;
    expect(cache.lookup('x.lab.test', RRType.A).kind).toBe('negative');
    clock.now += 2_000;
    expect(cache.lookup('x.lab.test', RRType.A).kind).toBe('miss');
  });

  it('skips an empty authoritative answer when asked to, and still keeps a name error', () => {
    const { cache } = cacheWith({ storeEmptyAuthoritative: false });
    cache.storeNegative('x.lab.test', RRType.AAAA, DnsRcode.NOERROR, soa(3600, 3600));
    cache.storeNegative('y.lab.test', RRType.A, DnsRcode.NXDOMAIN, soa(3600, 3600));
    expect(cache.lookup('x.lab.test', RRType.AAAA).kind).toBe('miss');
    expect(cache.lookup('y.lab.test', RRType.A).kind).toBe('negative');
  });
});

describe('locking', () => {
  it('refuses an overwrite while the locked share of the TTL has not passed', () => {
    const { cache, clock } = cacheWith({ lockingPercent: 50 });
    cache.storePositive([makeARecord('a.lab.test', 100, '10.0.0.1')]);
    clock.now += 49_000;
    cache.storePositive([makeARecord('a.lab.test', 100, '10.0.0.2')]);
    const held = cache.lookup('a.lab.test', RRType.A);
    expect(held.kind === 'hit' && String((held.records[0].data as { address: unknown }).address)).toBe('10.0.0.1');
    clock.now += 2_000;
    cache.storePositive([makeARecord('a.lab.test', 100, '10.0.0.2')]);
    const replaced = cache.lookup('a.lab.test', RRType.A);
    expect(replaced.kind === 'hit' && String((replaced.records[0].data as { address: unknown }).address)).toBe('10.0.0.2');
  });

  it('NON-REGRESSION: a lock of 100 percent ends with the TTL', () => {
    const { cache, clock } = cacheWith({ lockingPercent: 100 });
    cache.storePositive([makeARecord('a.lab.test', 100, '10.0.0.1')]);
    clock.now += 101_000;
    cache.storePositive([makeARecord('a.lab.test', 100, '10.0.0.2')]);
    const hit = cache.lookup('a.lab.test', RRType.A);
    expect(hit.kind === 'hit' && String((hit.records[0].data as { address: unknown }).address)).toBe('10.0.0.2');
  });
});

describe('size', () => {
  it('drops the oldest entries until the cache fits', () => {
    const { cache, clock } = cacheWith({ maxBytes: 100 });
    for (let n = 1; n <= 10; n++) {
      clock.now += 1_000;
      cache.storePositive([makeARecord(`h${n}.lab.test`, 3600, `10.0.0.${n}`)]);
    }
    expect(cache.size()).toBeLessThan(10);
    expect(cache.lookup('h10.lab.test', RRType.A).kind).toBe('hit');
    expect(cache.lookup('h1.lab.test', RRType.A).kind).toBe('miss');
  });
});

describe('unrelated records', () => {
  it('are refused unless the cache is told to admit them', () => {
    expect(cacheWith({}).cache.admitsUnrelatedRecords()).toBe(false);
    expect(cacheWith({ admitsUnrelatedRecords: true }).cache.admitsUnrelatedRecords()).toBe(true);
  });
});
