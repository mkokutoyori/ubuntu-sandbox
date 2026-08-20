/**
 * dialHttp — outbound HTTP client used by `curl`/`wget` (Linux) and
 * `Invoke-WebRequest` (Windows). Originally a JSON-PDU-over-raw-TCP stand-in
 * (PRD-Windows-Server.md §5 P11); migrated by `PRD-HTTP.md` §5 P12 onto the
 * real RFC 9112 engine (`Http1ClientSession`/`http1/Http1Wire.ts`) — same
 * public signature (`dialHttp`/`parseHttpUrl`/`HttpDialResult`), so
 * `HttpFetch.ts`/`Curl.ts`/`WindowsPC.invokeWebRequest` need no changes.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { Http1ClientSession } from './http1/Http1ClientSession';
import { createRequest, type HttpMethod } from './semantics/types';
import type { HttpResponsePdu } from './HttpTypes';

export interface HttpDialResult {
  ok: boolean;
  error?: string;
  response?: HttpResponsePdu;
}

export interface ParsedHttpUrl { host: string; port: number; path: string }

/** Parses `http(s)://host[:port][/path]` — shared by `curl`/`wget`/`Invoke-WebRequest`. */
export function parseHttpUrl(url: string): ParsedHttpUrl | null {
  const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url);
  if (!m) return null;
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 80, path: m[3] || '/' };
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function dialHttp(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  port?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): HttpDialResult {
  const port = opts.port ?? 80;
  const request = createRequest((opts.method as HttpMethod) ?? 'GET', opts.path ?? '/');
  request.headers.set('Host', opts.targetIp);
  for (const [k, v] of Object.entries(opts.headers ?? {})) request.headers.set(k, v);

  const session = new Http1ClientSession(opts.tcpStack, opts.targetIp, port);
  const result = session.send(request);
  session.close();

  if (!result.ok || !result.response) return { ok: false, error: result.error ?? 'Empty reply from server' };

  const msg = result.response;
  const headers: Record<string, string> = {};
  for (const [k, v] of msg.headers.entries()) headers[k] = v;

  return {
    ok: true,
    response: {
      type: 'http-response',
      statusCode: msg.statusCode ?? 0,
      statusText: msg.reasonPhrase ?? '',
      headers,
      body: msg.body ? bytesToBinaryString(msg.body) : '',
    },
  };
}
