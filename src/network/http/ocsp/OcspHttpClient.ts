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

export interface OcspWireDeps {
  tcpStack(): TcpStack;
  resolve?(name: string): string | null;
  now(): number;
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

export function queryOcspResponder(deps: OcspWireDeps, url: string, request: OcspRequestMessage): OcspQueryOutcome {
  const parsed = parseOcspUrl(url);
  if (!parsed) return { ok: false, reason: `invalid URL prefix in OCSP responder "${url}"` };
  const address = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host) ? parsed.host : deps.resolve?.(parsed.host) ?? null;
  if (address === null) return { ok: false, reason: `host not found in OCSP responder "${url}"` };
  const body = encodeOcspRequest(request);
  const http = createRequest('POST', parsed.path);
  http.headers.set('Host', parsed.port === 80 ? parsed.host : `${parsed.host}:${parsed.port}`);
  http.headers.set('Content-Type', OCSP_REQUEST_CONTENT_TYPE);
  http.headers.set('Content-Length', String(body.length));
  http.body = body;
  const session = new Http1ClientSession(deps.tcpStack(), address, parsed.port);
  const result = session.send(http);
  session.close();
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
}

export const DEFAULT_OCSP_POLICY: OcspPolicy = {
  responderUrl: null, overrideResponder: false, trusted: [], verifySignature: true,
  useNonce: true, skewMs: 300_000, maxAgeMs: null, cacheMs: 3_600_000,
};

export type OcspLookup =
  | { readonly ok: true; readonly single: OcspSingle; readonly response: OcspResponseMessage }
  | { readonly ok: false; readonly reason: string };

function randomNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

export class OcspClient {
  private readonly cache = new Map<string, { readonly single: OcspSingle; readonly response: OcspResponseMessage; readonly until: number }>();

  constructor(private readonly deps: OcspWireDeps, private readonly policy: OcspPolicy) {}

  responderFor(cert: X509Certificate): string | null {
    if (this.policy.overrideResponder && this.policy.responderUrl !== null) return this.policy.responderUrl;
    return ocspUrlOf(cert) ?? this.policy.responderUrl;
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
    const outcome = queryOcspResponder(this.deps, url, request);
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
    this.cache.set(key, { single, response, until: Math.min(single.nextUpdate ?? Number.MAX_SAFE_INTEGER, now + this.policy.cacheMs) });
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
