import type { TcpStack } from '@/network/tcp/TcpStack';
import { Http1ClientSession } from '../http1/Http1ClientSession';
import { createRequest } from '../semantics/types';
import {
  ocspCertIdFor, findSingle, ocspTimeIsValid, verifyOcspResponse, OCSP_REQUEST_CONTENT_TYPE,
  type OcspRequestMessage, type OcspResponseMessage, type OcspSingle,
} from '@/network/pki/OcspWire';
import { encodeOcspRequest, decodeOcspResponse } from '@/network/pki/der/OcspDer';
import type { IOcspResponder, OcspSingleResponse } from '@/network/pki/OcspResponder';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { PathClock } from '@/network/core/time/PathClock';

export interface OcspWireDeps {
  tcpStack(): TcpStack;
  resolve?(name: string): string | null;
  now(): number;
  readonly sharedCache?: Map<string, unknown>;
}

export type OcspQueryOutcome =
  | { readonly ok: true; readonly response: OcspResponseMessage }
  | { readonly ok: false; readonly reason: string };

export interface ParsedOcspUrl {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

export function parseOcspUrl(url: string): ParsedOcspUrl | null {
  const match = /^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url);
  if (!match) return null;
  return { host: match[1], port: match[2] === undefined ? 80 : Number(match[2]), path: match[3] ?? '/' };
}

export interface OcspQueryOptions {
  readonly timeoutMs?: number | null;
  readonly proxyUrl?: string | null;
}

function elapsedAcross<T>(act: () => T): { readonly value: T; readonly elapsedMs: number } {
  const startedAt = PathClock.now();
  const horizonBefore = PathClock.horizon();
  const value = act();
  const horizonAfter = PathClock.horizon();
  const reachedAt = horizonAfter > horizonBefore ? horizonAfter : PathClock.now();
  return { value, elapsedMs: Math.max(0, reachedAt - startedAt) };
}

function addressOf(deps: OcspWireDeps, host: string): string | null {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : deps.resolve?.(host) ?? null;
}

export function queryOcspResponder(
  deps: OcspWireDeps, url: string, request: OcspRequestMessage, options: OcspQueryOptions = {},
): OcspQueryOutcome {
  const parsed = parseOcspUrl(url);
  if (!parsed) return { ok: false, reason: `invalid URL prefix in OCSP responder "${url}"` };
  const proxy = options.proxyUrl ? parseOcspUrl(options.proxyUrl) : null;
  if (options.proxyUrl && !proxy) return { ok: false, reason: `invalid URL prefix in OCSP proxy "${options.proxyUrl}"` };
  const nextHop = proxy ?? parsed;
  const address = addressOf(deps, nextHop.host);
  if (address === null) return { ok: false, reason: `host not found in OCSP ${proxy ? 'proxy' : 'responder'} "${proxy ? options.proxyUrl : url}"` };
  const body = encodeOcspRequest(request);
  const http = createRequest('POST', proxy ? `http://${parsed.host}:${parsed.port}${parsed.path}` : parsed.path);
  http.headers.set('Host', parsed.port === 80 ? parsed.host : `${parsed.host}:${parsed.port}`);
  http.headers.set('Content-Type', OCSP_REQUEST_CONTENT_TYPE);
  http.headers.set('Content-Length', String(body.length));
  http.body = body;
  const timeoutMs = options.timeoutMs ?? null;
  const connected = elapsedAcross(() => deps.tcpStack().connect(address, nextHop.port));
  const socket = connected.value;
  if (!socket || socket.state !== 'established') return { ok: false, reason: 'connection refused' };
  if (timeoutMs !== null && connected.elapsedMs > timeoutMs) {
    socket.close();
    return { ok: false, reason: 'timed out connecting to the OCSP responder' };
  }
  const session = new Http1ClientSession(deps.tcpStack(), address, nextHop.port);
  session.adopt(socket);
  const exchanged = elapsedAcross(() => session.send(http));
  session.close();
  if (timeoutMs !== null && exchanged.elapsedMs > timeoutMs) return { ok: false, reason: 'timed out waiting for the OCSP response' };
  const result = exchanged.value;
  if (result.ok === false || !result.response) {
    return { ok: false, reason: result.ok === false ? result.error ?? 'no response' : 'no response' };
  }
  if (result.response.statusCode !== 200) return { ok: false, reason: `responder answered HTTP ${result.response.statusCode}` };
  try {
    return { ok: true, response: decodeOcspResponse(result.response.body ?? new Uint8Array(0)) };
  } catch {
    return { ok: false, reason: 'unreadable OCSP response' };
  }
}

export function ocspUrlOf(cert: X509Certificate): string | null {
  return cert.extensions?.authorityInfoAccess?.find((entry) => entry.method === 'OCSP')?.uri ?? null;
}

export interface OcspPolicy {
  readonly responderUrl: string | null;
  readonly overrideResponder: boolean;
  readonly trusted: readonly X509Certificate[];
  readonly verifySignature: boolean;
  readonly useNonce: boolean;
  readonly skewMs: number;
  readonly maxAgeMs: number | null;
  readonly cacheMs: number;
  readonly cacheUntilNextUpdate?: boolean;
  readonly cacheZone?: string;
  readonly timeoutMs: number | null;
  readonly proxyUrl: string | null;
}

export const DEFAULT_OCSP_POLICY: OcspPolicy = {
  responderUrl: null, overrideResponder: false, trusted: [], verifySignature: true,
  useNonce: true, skewMs: 300_000, maxAgeMs: null, cacheMs: 3_600_000, timeoutMs: null, proxyUrl: null,
};

export type OcspLookup =
  | { readonly ok: true; readonly single: OcspSingle; readonly response: OcspResponseMessage }
  | { readonly ok: false; readonly reason: string };

function randomNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

export interface StaplePolicy {
  readonly returnErrors: boolean;
  readonly fakeTryLater: boolean;
  readonly errorCacheMs: number;
}

export class OcspClient {
  private readonly stapleCache = new Map<string, { readonly response: OcspResponseMessage; readonly ok: boolean; readonly until: number }>();
  private readonly ownCache = new Map<string, { readonly single: OcspSingle; readonly response: OcspResponseMessage; readonly until: number }>();

  constructor(private readonly deps: OcspWireDeps, private readonly policy: OcspPolicy) {}

  private get cache(): Map<string, { readonly single: OcspSingle; readonly response: OcspResponseMessage; readonly until: number }> {
    const zone = this.policy.cacheZone;
    if (zone === undefined || this.deps.sharedCache === undefined) return this.ownCache;
    const key = `ocsp-zone:${zone}`;
    let shared = this.deps.sharedCache.get(key) as Map<string, { readonly single: OcspSingle; readonly response: OcspResponseMessage; readonly until: number }> | undefined;
    if (shared === undefined) { shared = new Map(); this.deps.sharedCache.set(key, shared); }
    return shared;
  }

  responderFor(cert: X509Certificate): string | null {
    if (this.policy.overrideResponder && this.policy.responderUrl !== null) return this.policy.responderUrl;
    return ocspUrlOf(cert) ?? this.policy.responderUrl;
  }

  stapleFor(cert: X509Certificate, issuer: X509Certificate, staple: StaplePolicy): OcspResponseMessage | null {
    const now = this.deps.now();
    const key = `${cert.issuer}#${cert.serialNumber}`;
    const serve = (entry: { readonly response: OcspResponseMessage; readonly ok: boolean }): OcspResponseMessage | null =>
      entry.ok || staple.returnErrors ? entry.response : null;
    const cached = this.stapleCache.get(key);
    if (cached && cached.until > now) return serve(cached);
    const url = this.responderFor(cert);
    if (url === null) return null;
    const request: OcspRequestMessage = { ids: [ocspCertIdFor(cert, issuer)] };
    const outcome = queryOcspResponder(this.deps, url, request, { timeoutMs: this.policy.timeoutMs, proxyUrl: this.policy.proxyUrl });
    let entry: { readonly response: OcspResponseMessage; readonly ok: boolean };
    if (outcome.ok === false) {
      if (!staple.fakeTryLater) return null;
      entry = { response: { status: 'tryLater', singles: [] }, ok: false };
    } else if (outcome.response.status !== 'successful') {
      entry = { response: outcome.response, ok: false };
    } else {
      const verified = !this.policy.verifySignature || verifyOcspResponse(outcome.response, request, this.policy.trusted, now, true).ok !== false;
      const single = findSingle(outcome.response, cert, issuer);
      entry = { response: outcome.response, ok: verified && single !== undefined && ocspTimeIsValid(single, now, this.policy.skewMs, this.policy.maxAgeMs) };
    }
    this.stapleCache.set(key, { ...entry, until: now + (entry.ok ? this.policy.cacheMs : staple.errorCacheMs) });
    return serve(entry);
  }

  lookup(cert: X509Certificate, issuer: X509Certificate | undefined): OcspLookup {
    if (issuer === undefined) return { ok: false, reason: 'issuer certificate not available' };
    const now = this.deps.now();
    const key = `${cert.issuer}#${cert.serialNumber}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > now) return { ok: true, single: cached.single, response: cached.response };
    const url = this.responderFor(cert);
    if (url === null) return { ok: false, reason: 'no OCSP responder URL' };
    const nonce = this.policy.useNonce ? randomNonce() : undefined;
    const request: OcspRequestMessage = { ids: [ocspCertIdFor(cert, issuer)], ...(nonce !== undefined ? { nonce } : {}) };
    const outcome = queryOcspResponder(this.deps, url, request, { timeoutMs: this.policy.timeoutMs, proxyUrl: this.policy.proxyUrl });
    if (outcome.ok === false) return outcome;
    const response = outcome.response;
    if (response.status !== 'successful') return { ok: false, reason: `responder error ${response.status}` };
    if (this.policy.verifySignature) {
      const verdict = verifyOcspResponse(response, request, this.policy.trusted, now, true);
      if (verdict.ok === false) return { ok: false, reason: `OCSP response verification failed: ${verdict.reason}` };
    }
    const single = findSingle(response, cert, issuer);
    if (!single) return { ok: false, reason: 'no status in the response for the certificate' };
    if (!ocspTimeIsValid(single, now, this.policy.skewMs, this.policy.maxAgeMs)) {
      return { ok: false, reason: 'OCSP response status times invalid' };
    }
    const bound = this.policy.cacheMs;
    const until = bound <= 0 ? 0
      : this.policy.cacheUntilNextUpdate === true ? single.nextUpdate ?? now + bound
        : Math.min(single.nextUpdate ?? Number.MAX_SAFE_INTEGER, now + bound);
    this.cache.set(key, { single, response, until });
    return { ok: true, single, response };
  }
}

export class WireOcspResponder implements IOcspResponder {
  constructor(private readonly client: OcspClient) {}

  check(cert: X509Certificate, now: number, issuer?: X509Certificate): OcspSingleResponse {
    const lookup = this.client.lookup(cert, issuer);
    if (lookup.ok === false) return { serialNumber: cert.serialNumber, status: 'unknown', producedAt: now, issuer: cert.issuer };
    const { single } = lookup;
    return {
      serialNumber: cert.serialNumber, status: single.status, producedAt: now, issuer: cert.issuer,
      ...(single.revokedAt !== undefined ? { revokedAt: single.revokedAt } : {}),
    };
  }
}
