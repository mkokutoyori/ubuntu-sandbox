/**
 * PRD-HTTP.md §5 P1 — HTTP semantics (RFC 9110): generic HttpMessage,
 * method properties, status code classes/redirection rules, conditional
 * requests, and content negotiation — all testable without any network.
 */
import { describe, it, expect } from 'vitest';
import { OrderedMultimap, createRequest, createResponse } from '@/network/http/semantics/types';
import { METHOD_PROPERTIES, isSafeMethod, isIdempotentMethod, isCacheableByDefault, isKnownMethod } from '@/network/http/semantics/methods';
import {
  statusClassOf,
  reasonPhraseFor,
  isRedirectStatus,
  redirectMethodFor,
  redirectPreservesBody,
} from '@/network/http/semantics/statusCodes';
import {
  parseETag,
  parseETagList,
  strongCompare,
  weakCompare,
  ifMatchPasses,
  ifNoneMatchMatches,
  notModifiedSince,
  ifUnmodifiedSincePasses,
  evaluatePreconditions,
  parseRange,
  ifRangeMatches,
} from '@/network/http/semantics/conditionalRequests';
import { parseWeightedList, selectBestMatch } from '@/network/http/semantics/contentNegotiation';

describe('OrderedMultimap', () => {
  it('preserves insertion order and allows duplicate keys via append', () => {
    const m = new OrderedMultimap<string>();
    m.append('Set-Cookie', 'a=1');
    m.append('Set-Cookie', 'b=2');
    m.append('Content-Type', 'text/html');
    expect(m.getAll('Set-Cookie')).toEqual(['a=1', 'b=2']);
    expect(m.entries().map(([k]) => k)).toEqual(['Set-Cookie', 'Set-Cookie', 'Content-Type']);
  });

  it('is case-insensitive for get/getAll/has/delete/set', () => {
    const m = new OrderedMultimap<string>();
    m.append('Content-Type', 'text/html');
    expect(m.get('content-type')).toBe('text/html');
    expect(m.has('CONTENT-TYPE')).toBe(true);
    m.set('content-type', 'application/json');
    expect(m.getAll('Content-Type')).toEqual(['application/json']);
    expect(m.delete('CoNtEnT-tYpE')).toBe(true);
    expect(m.has('content-type')).toBe(false);
  });

  it('set() replaces all prior entries for a key with a single one', () => {
    const m = new OrderedMultimap<string>();
    m.append('X-A', '1');
    m.append('X-A', '2');
    m.set('X-A', '3');
    expect(m.getAll('X-A')).toEqual(['3']);
  });
});

describe('HttpMessage factories', () => {
  it('createRequest builds a request-kind message with empty headers/body', () => {
    const req = createRequest('GET', '/index.html');
    expect(req.kind).toBe('request');
    expect(req.method).toBe('GET');
    expect(req.target).toBe('/index.html');
    expect(req.httpVersion).toBe('1.1');
    expect(req.body).toBeNull();
    expect(req.headers.size).toBe(0);
  });

  it('createResponse builds a response-kind message', () => {
    const res = createResponse(200, 'OK');
    expect(res.kind).toBe('response');
    expect(res.statusCode).toBe(200);
    expect(res.reasonPhrase).toBe('OK');
  });
});

describe('HTTP methods (RFC 9110 §9)', () => {
  it('GET/HEAD are safe, idempotent, and cacheable by default', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(isIdempotentMethod('GET')).toBe(true);
    expect(isCacheableByDefault('GET')).toBe(true);
    expect(isSafeMethod('HEAD')).toBe(true);
    expect(isCacheableByDefault('HEAD')).toBe(true);
  });

  it('POST is unsafe, non-idempotent, not cacheable by default', () => {
    expect(isSafeMethod('POST')).toBe(false);
    expect(isIdempotentMethod('POST')).toBe(false);
    expect(isCacheableByDefault('POST')).toBe(false);
  });

  it('PUT/DELETE are unsafe but idempotent', () => {
    expect(isSafeMethod('PUT')).toBe(false);
    expect(isIdempotentMethod('PUT')).toBe(true);
    expect(isSafeMethod('DELETE')).toBe(false);
    expect(isIdempotentMethod('DELETE')).toBe(true);
  });

  it('covers all nine RFC 9110 §9.3 methods', () => {
    expect(Object.keys(METHOD_PROPERTIES).sort()).toEqual(
      ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'].sort(),
    );
  });

  it('isKnownMethod distinguishes valid tokens from garbage', () => {
    expect(isKnownMethod('GET')).toBe(true);
    expect(isKnownMethod('FROB')).toBe(false);
  });
});

describe('Status codes and classes', () => {
  it('classifies codes into 1xx-5xx', () => {
    expect(statusClassOf(100)).toBe('1xx');
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf(301)).toBe('3xx');
    expect(statusClassOf(404)).toBe('4xx');
    expect(statusClassOf(500)).toBe('5xx');
  });

  it('rejects out-of-range codes', () => {
    expect(() => statusClassOf(999)).toThrow();
  });

  it('provides reason phrases for common codes', () => {
    expect(reasonPhraseFor(200)).toBe('OK');
    expect(reasonPhraseFor(404)).toBe('Not Found');
    expect(reasonPhraseFor(500)).toBe('Internal Server Error');
  });

  it('identifies redirect statuses', () => {
    expect(isRedirectStatus(301)).toBe(true);
    expect(isRedirectStatus(307)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
  });
});

describe('Redirect method/body preservation (RFC 9110 §15.4)', () => {
  it('303 always downgrades to GET (except HEAD stays HEAD) and drops the body', () => {
    expect(redirectMethodFor('POST', 303)).toBe('GET');
    expect(redirectMethodFor('PUT', 303)).toBe('GET');
    expect(redirectMethodFor('HEAD', 303)).toBe('HEAD');
    expect(redirectPreservesBody('POST', 303)).toBe(false);
  });

  it('301/302 downgrade POST to GET but preserve other methods', () => {
    expect(redirectMethodFor('POST', 301)).toBe('GET');
    expect(redirectMethodFor('POST', 302)).toBe('GET');
    expect(redirectMethodFor('PUT', 301)).toBe('PUT');
    expect(redirectMethodFor('GET', 302)).toBe('GET');
    expect(redirectPreservesBody('POST', 301)).toBe(false);
    expect(redirectPreservesBody('PUT', 301)).toBe(true);
  });

  it('307/308 always preserve method and body', () => {
    expect(redirectMethodFor('POST', 307)).toBe('POST');
    expect(redirectMethodFor('POST', 308)).toBe('POST');
    expect(redirectPreservesBody('POST', 307)).toBe(true);
    expect(redirectPreservesBody('POST', 308)).toBe(true);
  });

  it('throws for a non-redirect status', () => {
    expect(() => redirectMethodFor('GET', 200)).toThrow();
  });
});

describe('ETags (RFC 9110 §8.8.3)', () => {
  it('parses strong and weak etags', () => {
    expect(parseETag('"abc"')).toEqual({ value: 'abc', weak: false });
    expect(parseETag('W/"abc"')).toEqual({ value: 'abc', weak: true });
    expect(parseETag('not-quoted')).toBeNull();
  });

  it('parses a comma-separated list, ignoring commas inside quotes', () => {
    const list = parseETagList('"abc", W/"def", "gh,i"');
    expect(list).toEqual([
      { value: 'abc', weak: false },
      { value: 'def', weak: true },
      { value: 'gh,i', weak: false },
    ]);
  });

  it('strong comparison requires both strong and equal value', () => {
    expect(strongCompare({ value: 'x', weak: false }, { value: 'x', weak: false })).toBe(true);
    expect(strongCompare({ value: 'x', weak: true }, { value: 'x', weak: false })).toBe(false);
  });

  it('weak comparison ignores the weak flag', () => {
    expect(weakCompare({ value: 'x', weak: true }, { value: 'x', weak: false })).toBe(true);
    expect(weakCompare({ value: 'x', weak: false }, { value: 'y', weak: false })).toBe(false);
  });
});

describe('Conditional headers (RFC 9110 §13.1)', () => {
  it('If-Match: absent passes, "*" requires existence, list requires strong match', () => {
    expect(ifMatchPasses(undefined, 'abc')).toBe(true);
    expect(ifMatchPasses('*', 'abc')).toBe(true);
    expect(ifMatchPasses('*', undefined)).toBe(false);
    expect(ifMatchPasses('"abc"', 'abc')).toBe(true);
    expect(ifMatchPasses('"other"', 'abc')).toBe(false);
  });

  it('If-None-Match matches with weak comparison', () => {
    expect(ifNoneMatchMatches(undefined, 'abc')).toBe(false);
    expect(ifNoneMatchMatches('*', 'abc')).toBe(true);
    expect(ifNoneMatchMatches('W/"abc"', 'abc')).toBe(true);
    expect(ifNoneMatchMatches('"other"', 'abc')).toBe(false);
  });

  it('If-Modified-Since: true (not modified) only when lastModified <= header date', () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    expect(notModifiedSince(newer, older)).toBe(true);
    expect(notModifiedSince(older, newer)).toBe(false);
  });

  it('If-Unmodified-Since passes only when resource has not changed since', () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    expect(ifUnmodifiedSincePasses(newer, older)).toBe(true);
    expect(ifUnmodifiedSincePasses(older, newer)).toBe(false);
  });

  it('evaluatePreconditions: If-Match failing yields 412 regardless of other headers', () => {
    const result = evaluatePreconditions({ ifMatch: '"nope"' }, 'GET', { etag: 'abc' });
    expect(result.status).toBe(412);
  });

  it('evaluatePreconditions: If-None-Match match on GET yields 304', () => {
    const result = evaluatePreconditions({ ifNoneMatch: '"abc"' }, 'GET', { etag: 'abc' });
    expect(result.status).toBe(304);
  });

  it('evaluatePreconditions: If-None-Match match on POST yields 412', () => {
    const result = evaluatePreconditions({ ifNoneMatch: '"abc"' }, 'POST', { etag: 'abc' });
    expect(result.status).toBe(412);
  });

  it('evaluatePreconditions: If-Modified-Since unmodified on GET yields 304', () => {
    const lastModified = new Date('2026-01-01T00:00:00Z');
    const header = new Date('2026-06-01T00:00:00Z');
    const result = evaluatePreconditions({ ifModifiedSince: header }, 'GET', { lastModified });
    expect(result.status).toBe(304);
  });

  it('evaluatePreconditions: no conditional headers yields null (proceed normally)', () => {
    const result = evaluatePreconditions({}, 'GET', { etag: 'abc' });
    expect(result.status).toBeNull();
  });
});

describe('Range (RFC 9110 §14.2, single range only)', () => {
  it('parses a bounded range', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('rejects a multi-range request', () => {
    expect(parseRange('bytes=0-10,20-30', 1000)).toBeNull();
  });

  it('rejects an out-of-bounds range', () => {
    expect(parseRange('bytes=2000-3000', 1000)).toBeNull();
  });

  it('If-Range with a matching strong etag matches', () => {
    expect(ifRangeMatches('"abc"', { etag: 'abc' })).toBe(true);
    expect(ifRangeMatches('"other"', { etag: 'abc' })).toBe(false);
  });
});

describe('Content negotiation (RFC 9110 §12.5, name-only)', () => {
  it('parses a weighted list with q values', () => {
    expect(parseWeightedList('gzip;q=0.5, br;q=1.0, deflate')).toEqual([
      { value: 'gzip', q: 0.5 },
      { value: 'br', q: 1 },
      { value: 'deflate', q: 1 },
    ]);
  });

  it('selects the highest-q acceptable candidate', () => {
    expect(selectBestMatch('gzip;q=0.5, br;q=1.0', ['gzip', 'br'])).toBe('br');
  });

  it('an absent header means no preference — first available wins', () => {
    expect(selectBestMatch(undefined, ['gzip', 'br'])).toBe('gzip');
  });

  it('exact match beats wildcard even with a lower nominal position', () => {
    expect(selectBestMatch('text/plain;q=0.9, text/*;q=1.0', ['text/plain', 'text/html'])).toBe('text/html');
  });

  it('an explicit q=0 rejects a candidate even under a permissive wildcard', () => {
    expect(selectBestMatch('gzip;q=0, *;q=1.0', ['gzip', 'br'])).toBe('br');
  });

  it('returns null when nothing is acceptable', () => {
    expect(selectBestMatch('gzip;q=0', ['gzip'])).toBeNull();
  });
});
