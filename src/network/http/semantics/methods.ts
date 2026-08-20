import type { HttpMethod, MethodProperties } from './types';

// RFC 9110 §9.2 (safe/idempotent), §9.3 (per-method), §9.2.3 (cacheable defaults, RFC 9111 §3)
export const METHOD_PROPERTIES: Record<HttpMethod, MethodProperties> = {
  GET: { safe: true, idempotent: true, cacheableByDefault: true },
  HEAD: { safe: true, idempotent: true, cacheableByDefault: true },
  POST: { safe: false, idempotent: false, cacheableByDefault: false },
  PUT: { safe: false, idempotent: true, cacheableByDefault: false },
  DELETE: { safe: false, idempotent: true, cacheableByDefault: false },
  CONNECT: { safe: false, idempotent: false, cacheableByDefault: false },
  OPTIONS: { safe: true, idempotent: true, cacheableByDefault: false },
  TRACE: { safe: true, idempotent: true, cacheableByDefault: false },
  PATCH: { safe: false, idempotent: false, cacheableByDefault: false },
};

export function isSafeMethod(method: HttpMethod): boolean {
  return METHOD_PROPERTIES[method].safe;
}

export function isIdempotentMethod(method: HttpMethod): boolean {
  return METHOD_PROPERTIES[method].idempotent;
}

export function isCacheableByDefault(method: HttpMethod): boolean {
  return METHOD_PROPERTIES[method].cacheableByDefault;
}

export function isKnownMethod(value: string): value is HttpMethod {
  return Object.prototype.hasOwnProperty.call(METHOD_PROPERTIES, value);
}
