/**
 * PRD-HTTP.md §5 P3 — HTTP cache (RFC 9111): Cache-Control parsing,
 * freshness/age computation (explicit max-age/Expires and the 10%
 * heuristic), conditional revalidation (304 refreshes in place), and
 * invalidation on a successful unsafe method against the same URI.
 */
import { describe, it, expect } from 'vitest';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { parseCacheControl } from '@/network/http/cache/CacheControl';
import { HttpCacheStore, computeFreshnessLifetimeMs } from '@/network/http/cache/HttpCacheStore';

describe('parseCacheControl', () => {
  it('parses no-store/no-cache/must-revalidate/immutable flags', () => {
    const cc = parseCacheControl('no-store, no-cache, must-revalidate, immutable');
    expect(cc.noStore).toBe(true);
    expect(cc.noCache).toBe(true);
    expect(cc.mustRevalidate).toBe(true);
    expect(cc.immutable).toBe(true);
  });

  it('parses max-age and s-maxage', () => {
    const cc = parseCacheControl('max-age=60, s-maxage=120');
    expect(cc.maxAge).toBe(60);
    expect(cc.sMaxage).toBe(120);
  });

  it('parses private/public', () => {
    expect(parseCacheControl('private').isPrivate).toBe(true);
    expect(parseCacheControl('public').isPublic).toBe(true);
  });

  it('returns all-false/undefined defaults for an absent header', () => {
    const cc = parseCacheControl(undefined);
    expect(cc.noStore).toBe(false);
    expect(cc.maxAge).toBeUndefined();
  });
});

describe('computeFreshnessLifetimeMs', () => {
  it('max-age wins when present', () => {
    const res = createResponse(200, 'OK');
    const cc = parseCacheControl('max-age=60');
    expect(computeFreshnessLifetimeMs(res, cc, Date.now())).toBe(60_000);
  });

  it('falls back to Expires - Date when no max-age', () => {
    const res = createResponse(200, 'OK');
    res.headers.set('Date', 'Mon, 01 Jan 2026 00:00:00 GMT');
    res.headers.set('Expires', 'Mon, 01 Jan 2026 00:01:00 GMT');
    const cc = parseCacheControl(undefined);
    expect(computeFreshnessLifetimeMs(res, cc, Date.now())).toBe(60_000);
  });

  it('uses the 10% Last-Modified heuristic when nothing explicit is present', () => {
    const now = new Date('2026-01-01T01:00:00Z').getTime();
    const res = createResponse(200, 'OK');
    res.headers.set('Last-Modified', new Date(now - 100_000).toUTCString());
    const cc = parseCacheControl(undefined);
    expect(computeFreshnessLifetimeMs(res, cc, now)).toBeCloseTo(10_000, -2);
  });

  it('is zero when there is no freshness information at all', () => {
    const res = createResponse(200, 'OK');
    const cc = parseCacheControl(undefined);
    expect(computeFreshnessLifetimeMs(res, cc, Date.now())).toBe(0);
  });
});

describe('HttpCacheStore — storage and freshness', () => {
  it('stores and retrieves a GET response by method+URI', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=60');
    store.put(req, res);
    expect(store.get(req)).toBeDefined();
    expect(store.size).toBe(1);
  });

  it('never stores a response marked no-store', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'no-store');
    store.put(req, res);
    expect(store.get(req)).toBeUndefined();
  });

  it('never stores a non-GET request', () => {
    const store = new HttpCacheStore();
    const req = createRequest('POST', '/a');
    const res = createResponse(200, 'OK');
    store.put(req, res);
    expect(store.size).toBe(0);
  });

  it('isFresh is true within max-age and false after it elapses', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=10');
    const now = Date.now();
    store.put(req, res, now);
    const entry = store.get(req)!;
    expect(store.isFresh(entry, now + 5_000)).toBe(true);
    expect(store.isFresh(entry, now + 15_000)).toBe(false);
  });

  it('no-cache/must-revalidate is never served without revalidation', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'no-cache, max-age=60');
    const now = Date.now();
    store.put(req, res, now);
    expect(store.isFresh(store.get(req)!, now)).toBe(false);
  });

  it('separates entries by Vary-selected request headers', () => {
    const store = new HttpCacheStore();
    const resEn = createResponse(200, 'OK');
    resEn.headers.set('Vary', 'Accept-Language');
    resEn.headers.set('Cache-Control', 'max-age=60');
    const reqEn = createRequest('GET', '/a');
    reqEn.headers.set('Accept-Language', 'en');
    store.put(reqEn, resEn);

    const reqFr = createRequest('GET', '/a');
    reqFr.headers.set('Accept-Language', 'fr');
    expect(store.get(reqFr)).toBeUndefined();
    expect(store.get(reqEn)).toBeDefined();
  });
});

describe('HttpCacheStore — conditional revalidation (RFC 9111 §4.3)', () => {
  it('builds If-None-Match/If-Modified-Since from a stored entry', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('ETag', '"abc"');
    res.headers.set('Last-Modified', 'Mon, 01 Jan 2026 00:00:00 GMT');
    store.put(req, res);
    const headers = store.buildRevalidationHeaders(store.get(req)!);
    expect(headers.ifNoneMatch).toBe('"abc"');
    expect(headers.ifModifiedSince).toBeInstanceOf(Date);
  });

  it('a 304 revalidation response refreshes freshness in place, keeping the old body', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=1');
    res.headers.set('ETag', '"abc"');
    res.body = new TextEncoder().encode('original body');
    const now = Date.now();
    store.put(req, res, now);

    const stale = now + 5_000;
    expect(store.isFresh(store.get(req)!, stale)).toBe(false);

    const revalidation = createResponse(304, 'Not Modified');
    revalidation.headers.set('Cache-Control', 'max-age=60');
    store.applyRevalidationResponse(req, revalidation, stale);

    const entry = store.get(req)!;
    expect(store.isFresh(entry, stale)).toBe(true);
    expect(new TextDecoder().decode(entry.response.body!)).toBe('original body');
  });

  it('a 200 revalidation response replaces the entry entirely', () => {
    const store = new HttpCacheStore();
    const req = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=1');
    res.body = new TextEncoder().encode('old');
    store.put(req, res);

    const fresh = createResponse(200, 'OK');
    fresh.headers.set('Cache-Control', 'max-age=60');
    fresh.body = new TextEncoder().encode('new');
    store.applyRevalidationResponse(req, fresh);

    expect(new TextDecoder().decode(store.get(req)!.response.body!)).toBe('new');
  });
});

describe('HttpCacheStore — invalidation (RFC 9111 §4.4)', () => {
  it('a successful POST to the same URI invalidates the cached GET', () => {
    const store = new HttpCacheStore();
    const getReq = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=60');
    store.put(getReq, res);
    expect(store.get(getReq)).toBeDefined();

    const postReq = createRequest('POST', '/a');
    const postRes = createResponse(200, 'OK');
    store.invalidateOnResponse(postReq, postRes);
    expect(store.get(getReq)).toBeUndefined();
  });

  it('a failed POST (5xx) does not invalidate the cache', () => {
    const store = new HttpCacheStore();
    const getReq = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=60');
    store.put(getReq, res);

    const postReq = createRequest('POST', '/a');
    const postRes = createResponse(500, 'Internal Server Error');
    store.invalidateOnResponse(postReq, postRes);
    expect(store.get(getReq)).toBeDefined();
  });

  it('a safe method (GET) never invalidates', () => {
    const store = new HttpCacheStore();
    const getReq = createRequest('GET', '/a');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=60');
    store.put(getReq, res);

    store.invalidateOnResponse(createRequest('GET', '/a'), createResponse(200, 'OK'));
    expect(store.get(getReq)).toBeDefined();
  });
});
