import type { TcpStack } from '@/network/tcp/TcpStack';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { bytesToBinaryString, binaryStringToBytes } from '@/crypto/encoding';
import { IPAddress } from '@/network/core/types';
import { ENROLLMENT_PATH } from './IosCertificateServer';

export interface EnrollmentEndpoint {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

export function parseEnrollmentUrl(url: string): EnrollmentEndpoint | null {
  const match = /^http:\/\/([^/:]+)(?::(\d{1,5}))?(\/[^?]*)?$/i.exec(url.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : 80;
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port, path: match[3] && match[3] !== '/' ? match[3] : ENROLLMENT_PATH };
}

export function parseDocumentUrl(url: string): EnrollmentEndpoint | null {
  const match = /^http:\/\/([^/:]+)(?::(\d{1,5}))?(\/.*)?$/i.exec(url.trim());
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : 80;
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port, path: match[3] ?? '/' };
}

export interface PkiReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly status: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'NONE';
  readonly transaction: number | null;
  readonly body: string;
}

export interface PkiClientDeps {
  tcp(): TcpStack;
  resolve(host: string): string | null;
}

export class PkiEnrollmentClient {
  constructor(private readonly deps: PkiClientDeps) {}

  private async call(
    endpoint: EnrollmentEndpoint, method: 'GET' | 'POST', query: string, body?: string,
  ): Promise<PkiReply> {
    const address = IPAddress.tryParse(endpoint.host)?.toString() ?? this.deps.resolve(endpoint.host);
    if (address === null) {
      return { ok: false, error: `% Unable to resolve ${endpoint.host}`, status: 'NONE', transaction: null, body: '' };
    }
    const request = createRequest(method, query === '' ? endpoint.path : `${endpoint.path}?${query}`);
    request.headers.set('Host', endpoint.host);
    if (body !== undefined) {
      request.headers.set('Content-Type', 'application/x-pki-message');
      request.body = binaryStringToBytes(body);
    }
    const session = new Http1ClientSession(this.deps.tcp(), address, endpoint.port);
    const result = await session.sendAsync(request);
    session.close();
    if (!result.ok || !result.response) {
      return { ok: false, error: result.error ?? 'no response', status: 'NONE', transaction: null, body: '' };
    }
    const response = result.response;
    const status = (response.headers.get('X-Pki-Status') ?? 'NONE') as PkiReply['status'];
    const txn = response.headers.get('X-Pki-Transaction');
    return {
      ok: (response.statusCode ?? 0) === 200,
      error: (response.statusCode ?? 0) === 200 ? undefined : `HTTP ${response.statusCode}`,
      status,
      transaction: txn === null ? null : Number(txn),
      body: response.body ? bytesToBinaryString(response.body) : '',
    };
  }

  getDocument(endpoint: EnrollmentEndpoint): Promise<PkiReply> {
    return this.call(endpoint, 'GET', '');
  }

  getCaCertificate(endpoint: EnrollmentEndpoint): Promise<PkiReply> {
    return this.call(endpoint, 'GET', 'operation=GetCACert');
  }

  submit(endpoint: EnrollmentEndpoint, csrPem: string): Promise<PkiReply> {
    return this.call(endpoint, 'POST', 'operation=PKIOperation', csrPem);
  }

  poll(endpoint: EnrollmentEndpoint, transaction: number): Promise<PkiReply> {
    return this.call(endpoint, 'GET', `operation=GetCertInitial&transactionId=${transaction}`);
  }

  getCrl(endpoint: EnrollmentEndpoint): Promise<PkiReply> {
    return this.call(endpoint, 'GET', 'operation=GetCRL');
  }
}
