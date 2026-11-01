/*
 * Structure — the cache settings of the Windows DNS server as DnsServerParameters reads and writes them, under the names
 * [MS-DNSP] 3.1.1.1.1 gives the properties (MaxCacheTtl, MaxNegativeCacheTtl, MaxCacheSize, SecureResponses,
 * CacheEmptyAuthResponses, CacheLockingPercent), with their documented defaults, and the limits the cache is given
 * from them (a size target of 90 percent of MaxCacheSize, 0 meaning no limit, a locking percentage held to 0..100).
 * Discrimination (run on the tree before the change, which already held a first version of these settings): 2 of the 7
 * cases fall (the registry name of CacheEmptyAuthResponses, which was a guess, and the 90 percent size target). The
 * five that pass either way are the WITNESS (a parameter store answers for a name nobody wrote) and four
 * NON-REGRESSIONS (the defaults, a change keeps what it leaves out, the locking percentage held to 0..100, SecureResponses
 * 0 admitting unrelated records).
 */
import { describe, it, expect } from 'vitest';
import { DnsServerParameters, MemoryDnsParameterStore } from '@/network/devices/windows/server/dns/DnsServerParameters';

function parameters() {
  const store = new MemoryDnsParameterStore();
  return { parameters: new DnsServerParameters(store), store };
}

describe('the cache settings of the DNS server', () => {
  it('WITNESS: a parameter nobody wrote reads as its default', () => {
    expect(parameters().parameters.forwardingTimeoutSeconds()).toBe(3);
  });

  it('are the documented defaults when nothing was written', () => {
    expect(parameters().parameters.cacheSettings()).toEqual({
      maxTtlSeconds: 86400, maxNegativeTtlSeconds: 900, maxKBSize: 0, pollutionProtection: true,
      lockingPercent: 100, storeEmptyAuthenticationResponse: true, ignorePolicies: false,
    });
  });

  it('are written under the [MS-DNSP] property names', () => {
    const { parameters: p, store } = parameters();
    p.setCacheSettings({
      maxTtlSeconds: 600, maxNegativeTtlSeconds: 120, maxKBSize: 2048, pollutionProtection: false,
      lockingPercent: 50, storeEmptyAuthenticationResponse: false,
    });
    expect(store.read('MaxCacheTtl')).toBe(600);
    expect(store.read('MaxNegativeCacheTtl')).toBe(120);
    expect(store.read('MaxCacheSize')).toBe(2048);
    expect(store.read('SecureResponses')).toBe(0);
    expect(store.read('CacheLockingPercent')).toBe(50);
    expect(store.read('CacheEmptyAuthResponses')).toBe(0);
  });

  it('a setting left out of a change keeps its value', () => {
    const { parameters: p } = parameters();
    p.setCacheSettings({ maxTtlSeconds: 600 });
    p.setCacheSettings({ lockingPercent: 10 });
    expect(p.cacheSettings().maxTtlSeconds).toBe(600);
    expect(p.cacheSettings().lockingPercent).toBe(10);
  });

  it('give the cache a size target of 90 percent of MaxCacheSize, and none when it is 0', () => {
    const { parameters: p } = parameters();
    expect(p.cacheLimits().maxBytes).toBeNull();
    p.setCacheSettings({ maxKBSize: 1000 });
    expect(p.cacheLimits().maxBytes).toBe(921600);
  });

  it('hold the locking percentage to 0..100 whatever the registry says', () => {
    const { parameters: p, store } = parameters();
    store.write('CacheLockingPercent', 'DWord', 250);
    expect(p.cacheSettings().lockingPercent).toBe(100);
    store.write('CacheLockingPercent', 'DWord', -5);
    expect(p.cacheSettings().lockingPercent).toBe(0);
  });

  it('admit unrelated records exactly when SecureResponses is 0', () => {
    const { parameters: p } = parameters();
    expect(p.cacheLimits().admitsUnrelatedRecords).toBe(false);
    p.setCacheSettings({ pollutionProtection: false });
    expect(p.cacheLimits().admitsUnrelatedRecords).toBe(true);
  });
});
