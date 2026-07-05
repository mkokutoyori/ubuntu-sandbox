import type { HttpMethod } from './types';

export interface ETagValue {
  value: string;
  weak: boolean;
}

export interface ResourceState {
  etag?: string;
  lastModified?: Date;
}

// RFC 9110 §8.8.3
export function parseETag(raw: string): ETagValue | null {
  const trimmed = raw.trim();
  const weak = trimmed.startsWith('W/');
  const quoted = weak ? trimmed.slice(2) : trimmed;
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) return null;
  return { value: quoted.slice(1, -1), weak };
}

export function parseETagList(header: string): ETagValue[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of header) {
    if (ch === '"') depth = depth === 0 ? 1 : 0;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => parseETag(p)).filter((e): e is ETagValue => e !== null);
}

// RFC 9110 §8.8.3.2 — strong comparison requires both non-weak and equal opaque value.
export function strongCompare(a: ETagValue, b: ETagValue): boolean {
  return !a.weak && !b.weak && a.value === b.value;
}

// Weak comparison ignores the weak indicator, compares only the opaque value.
export function weakCompare(a: ETagValue, b: ETagValue): boolean {
  return a.value === b.value;
}

/** RFC 9110 §13.1.1 — If-Match. Undefined header means the precondition is absent (passes). */
export function ifMatchPasses(headerValue: string | undefined, currentEtag: string | undefined): boolean {
  if (headerValue === undefined) return true;
  if (headerValue.trim() === '*') return currentEtag !== undefined;
  if (currentEtag === undefined) return false;
  const current = parseETag(`"${currentEtag}"`);
  if (!current) return false;
  return parseETagList(headerValue).some((candidate) => strongCompare(candidate, current));
}

/** RFC 9110 §13.1.2 — If-None-Match. Returns true when the resource matches (i.e. request should be treated as "not modified"). */
export function ifNoneMatchMatches(headerValue: string | undefined, currentEtag: string | undefined): boolean {
  if (headerValue === undefined) return false;
  if (headerValue.trim() === '*') return currentEtag !== undefined;
  if (currentEtag === undefined) return false;
  const current = parseETag(`"${currentEtag}"`);
  if (!current) return false;
  return parseETagList(headerValue).some((candidate) => weakCompare(candidate, current));
}

/** RFC 9110 §13.1.3 — If-Modified-Since. True means unchanged (should 304). */
export function notModifiedSince(headerDate: Date | undefined, lastModified: Date | undefined): boolean {
  if (!headerDate || !lastModified) return false;
  return lastModified.getTime() <= headerDate.getTime();
}

/** RFC 9110 §13.1.4 — If-Unmodified-Since. True means the precondition passes. */
export function ifUnmodifiedSincePasses(headerDate: Date | undefined, lastModified: Date | undefined): boolean {
  if (!headerDate) return true;
  if (!lastModified) return true;
  return lastModified.getTime() <= headerDate.getTime();
}

export interface ConditionalHeaders {
  ifMatch?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: Date;
  ifUnmodifiedSince?: Date;
}

export interface PreconditionResult {
  status: 304 | 412 | null;
}

// RFC 9110 §13.2.2 evaluation order.
export function evaluatePreconditions(headers: ConditionalHeaders, method: HttpMethod, resource: ResourceState): PreconditionResult {
  if (headers.ifMatch !== undefined) {
    if (!ifMatchPasses(headers.ifMatch, resource.etag)) return { status: 412 };
  } else if (headers.ifUnmodifiedSince !== undefined) {
    if (!ifUnmodifiedSincePasses(headers.ifUnmodifiedSince, resource.lastModified)) return { status: 412 };
  }

  const isGetOrHead = method === 'GET' || method === 'HEAD';

  if (headers.ifNoneMatch !== undefined) {
    const matched = ifNoneMatchMatches(headers.ifNoneMatch, resource.etag);
    if (matched) return { status: isGetOrHead ? 304 : 412 };
  } else if (isGetOrHead && headers.ifModifiedSince !== undefined) {
    if (notModifiedSince(headers.ifModifiedSince, resource.lastModified)) return { status: 304 };
  }

  return { status: null };
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * RFC 9110 §14.2 — a single `bytes=start-end` / `bytes=start-` / `bytes=-suffixLength`
 * range (multiple ranges are out of scope, cf. PRD-HTTP.md §2.1.A). Returns null for
 * a malformed or unsatisfiable range (caller responds 416).
 */
export function parseRange(header: string, resourceLength: number): ByteRange | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || header.includes(',')) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;
  if (startStr === '') {
    const suffixLength = parseInt(endStr, 10);
    if (suffixLength <= 0) return null;
    start = Math.max(0, resourceLength - suffixLength);
    end = resourceLength - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? resourceLength - 1 : parseInt(endStr, 10);
  }

  if (start > end || start >= resourceLength || start < 0) return null;
  return { start, end: Math.min(end, resourceLength - 1) };
}

/** RFC 9110 §13.1.5 — If-Range. Accepts either an ETag or an HTTP-date form. */
export function ifRangeMatches(headerValue: string, resource: ResourceState): boolean {
  const trimmed = headerValue.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('W/"')) {
    const candidate = parseETag(trimmed);
    if (!candidate || resource.etag === undefined) return false;
    const current = parseETag(`"${resource.etag}"`);
    return current !== null && strongCompare(candidate, current);
  }
  const headerDate = new Date(trimmed);
  if (isNaN(headerDate.getTime()) || !resource.lastModified) return false;
  return headerDate.getTime() === resource.lastModified.getTime();
}
