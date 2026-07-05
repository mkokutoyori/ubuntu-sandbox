import type { HttpMessage, HttpMethod } from '../semantics/types';
import { isSafeMethod } from '../semantics/methods';
import { parseETag, type ConditionalHeaders } from '../semantics/conditionalRequests';
import { parseCacheControl, type CacheControlDirectives } from './CacheControl';

export interface CacheKey {
  method: HttpMethod;
  uri: string;
  vary: Record<string, string>;
}

export interface CacheEntry {
  key: CacheKey;
  response: HttpMessage;
  storedAt: number;
  freshnessLifetimeMs: number;
  etag?: string;
  lastModified?: Date;
  mustRevalidate: boolean;
}

// RFC 9111 §4.2.1 (explicit) / §4.2.2 (heuristic, 10% of time since Last-Modified).
export function computeFreshnessLifetimeMs(
  response: HttpMessage,
  cc: CacheControlDirectives,
  now: number,
  lastModifiedOverride?: Date,
): number {
  if (cc.maxAge !== undefined) return Math.max(0, cc.maxAge * 1000);

  const expiresHeader = response.headers.get('Expires');
  if (expiresHeader) {
    const expires = new Date(expiresHeader);
    const dateHeader = response.headers.get('Date');
    const baseline = dateHeader ? new Date(dateHeader).getTime() : now;
    if (!isNaN(expires.getTime())) return Math.max(0, expires.getTime() - baseline);
  }

  const lastModified = lastModifiedOverride ?? (() => {
    const header = response.headers.get('Last-Modified');
    if (!header) return undefined;
    const d = new Date(header);
    return isNaN(d.getTime()) ? undefined : d;
  })();
  if (lastModified) return Math.max(0, (now - lastModified.getTime()) * 0.1);

  return 0;
}

/**
 * A private, per-agent HTTP cache (RFC 9111) — not a shared/proxy cache
 * (cf. PRD-HTTP.md §2.2), so `s-maxage` is parsed but not honored (it only
 * governs shared caches; `max-age` and the heuristic apply here instead).
 */
export class HttpCacheStore {
  private entries = new Map<string, CacheEntry>();

  private keyString(method: HttpMethod, uri: string, vary: Record<string, string>): string {
    const sorted = Object.keys(vary).sort().map((k) => `${k}=${vary[k]}`);
    return `${method} ${uri} ${sorted.join('&')}`;
  }

  private varySubset(request: HttpMessage, response: HttpMessage): Record<string, string> {
    const varyHeader = response.headers.get('Vary');
    const result: Record<string, string> = {};
    if (!varyHeader) return result;
    if (varyHeader.trim() === '*') return { '*': String(Math.random()) };
    for (const name of varyHeader.split(',').map((s) => s.trim().toLowerCase())) {
      const v = request.headers.get(name);
      if (v !== undefined) result[name] = v;
    }
    return result;
  }

  private matchesVary(entry: CacheEntry, request: HttpMessage): boolean {
    for (const name of Object.keys(entry.key.vary)) {
      if (name === '*') return false;
      if (request.headers.get(name) !== entry.key.vary[name]) return false;
    }
    return true;
  }

  put(request: HttpMessage, response: HttpMessage, now = Date.now()): void {
    if (request.method !== 'GET') return;
    const cc = parseCacheControl(response.headers.get('Cache-Control'));
    if (cc.noStore) return;

    const uri = request.target ?? '';
    const vary = this.varySubset(request, response);
    const etagHeader = response.headers.get('ETag');
    const etag = etagHeader ? parseETag(etagHeader)?.value : undefined;
    const lastModifiedHeader = response.headers.get('Last-Modified');
    const lastModified = lastModifiedHeader && !isNaN(new Date(lastModifiedHeader).getTime())
      ? new Date(lastModifiedHeader) : undefined;

    const entry: CacheEntry = {
      key: { method: request.method, uri, vary },
      response,
      storedAt: now,
      freshnessLifetimeMs: computeFreshnessLifetimeMs(response, cc, now, lastModified),
      etag,
      lastModified,
      mustRevalidate: cc.noCache || cc.mustRevalidate,
    };
    this.entries.set(this.keyString(request.method, uri, vary), entry);
  }

  get(request: HttpMessage): CacheEntry | undefined {
    if (request.method !== 'GET') return undefined;
    const uri = request.target ?? '';
    for (const entry of this.entries.values()) {
      if (entry.key.method === request.method && entry.key.uri === uri && this.matchesVary(entry, request)) {
        return entry;
      }
    }
    return undefined;
  }

  ageMs(entry: CacheEntry, now = Date.now()): number {
    const ageHeader = entry.response.headers.get('Age');
    const initialAgeMs = ageHeader ? Math.max(0, parseInt(ageHeader, 10) * 1000) : 0;
    return initialAgeMs + Math.max(0, now - entry.storedAt);
  }

  isFresh(entry: CacheEntry, now = Date.now()): boolean {
    if (entry.mustRevalidate) return false;
    return this.ageMs(entry, now) < entry.freshnessLifetimeMs;
  }

  buildRevalidationHeaders(entry: CacheEntry): ConditionalHeaders {
    const headers: ConditionalHeaders = {};
    if (entry.etag) headers.ifNoneMatch = `"${entry.etag}"`;
    if (entry.lastModified) headers.ifModifiedSince = entry.lastModified;
    return headers;
  }

  /** RFC 9111 §4.3.3 — 304 refreshes stored metadata/freshness in place; anything else replaces the entry. */
  applyRevalidationResponse(request: HttpMessage, revalidationResponse: HttpMessage, now = Date.now()): void {
    if (revalidationResponse.statusCode === 304) {
      const entry = this.get(request);
      if (!entry) return;
      const cc = parseCacheControl(revalidationResponse.headers.get('Cache-Control'));
      entry.storedAt = now;
      entry.freshnessLifetimeMs = computeFreshnessLifetimeMs(entry.response, cc, now, entry.lastModified);
      entry.mustRevalidate = cc.noCache || cc.mustRevalidate;
      for (const [k, v] of revalidationResponse.headers.entries()) {
        if (k.toLowerCase() !== 'content-length') entry.response.headers.set(k, v);
      }
    } else {
      this.put(request, revalidationResponse, now);
    }
  }

  /** RFC 9111 §4.4 — a successful (2xx/3xx) unsafe-method response invalidates cached representations of the same URI. */
  invalidateOnResponse(request: HttpMessage, response: HttpMessage): void {
    if (!request.method || isSafeMethod(request.method)) return;
    if (response.statusCode === undefined || response.statusCode >= 400) return;
    this.invalidate(request.target ?? '');
  }

  invalidate(uri: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.key.uri === uri) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
