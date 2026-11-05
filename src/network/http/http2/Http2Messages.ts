import { createRequest, createResponse, type HttpMessage, type HttpMethod } from '../semantics/types';
import { reasonPhraseFor } from '../semantics/statusCodes';
import type { Http2RequestResult } from './Http2Connection';

const CONNECTION_SPECIFIC = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host']);

function forwardedHeaders(message: HttpMessage): [string, string][] {
  const forwarded: [string, string][] = [];
  for (const [name, value] of message.headers) {
    const lower = name.toLowerCase();
    if (!CONNECTION_SPECIFIC.has(lower)) forwarded.push([lower, value]);
  }
  const hasBody = message.body !== null && message.body.length > 0;
  if (hasBody && !message.headers.has('Content-Length')) forwarded.push(['content-length', String(message.body!.length)]);
  return forwarded;
}

function pseudoValue(headers: readonly [string, string][], name: string): string | undefined {
  return headers.find(([key]) => key === name)?.[1];
}

export function requestToHttp2(request: HttpMessage, scheme: 'http' | 'https'): [string, string][] {
  return [
    [':method', request.method ?? 'GET'],
    [':scheme', scheme],
    [':authority', request.headers.get('Host') ?? ''],
    [':path', request.target ?? '/'],
    ...forwardedHeaders(request),
  ];
}

export function http2ToRequest(headers: [string, string][], body: Uint8Array): HttpMessage {
  const request = createRequest((pseudoValue(headers, ':method') ?? 'GET') as HttpMethod, pseudoValue(headers, ':path') ?? '/', '2');
  const authority = pseudoValue(headers, ':authority');
  if (authority !== undefined) request.headers.set('Host', authority);
  for (const [name, value] of headers) if (!name.startsWith(':')) request.headers.append(name, value);
  request.body = body.length > 0 ? body : null;
  return request;
}

export function responseToHttp2(response: HttpMessage): Http2RequestResult {
  return {
    headers: [[':status', String(response.statusCode ?? 200)], ...forwardedHeaders(response)],
    body: response.body ?? new Uint8Array(0),
  };
}

export function http2ToResponse(result: Http2RequestResult): HttpMessage {
  const statusCode = Number(pseudoValue(result.headers, ':status') ?? 0);
  const response = createResponse(statusCode, reasonPhraseFor(statusCode), '2');
  for (const [name, value] of result.headers) if (!name.startsWith(':')) response.headers.append(name, value);
  response.body = result.body.length > 0 ? result.body : null;
  return response;
}
