/**
 * dialHttp — outbound HTTP client used by `curl`/`wget` (Linux) and
 * `Invoke-WebRequest` (Windows) — PRD-Windows-Server.md §5 P11. Dials the
 * real per-device `TcpStack` (real handshake/routing/refused-connection
 * semantics, same as `dialSmbShare`), sends one `HttpRequestPdu`, and
 * synchronously captures the single `HttpResponsePdu` reply — this
 * simulator's TCP delivery is synchronous end to end, so the whole
 * round trip completes inline.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { type HttpResponsePdu, isHttpResponsePdu } from './HttpTypes';

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

export function dialHttp(opts: {
  tcpStack: TcpStack;
  targetIp: string;
  port?: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): HttpDialResult {
  const port = opts.port ?? 80;
  const socket = opts.tcpStack.connect(opts.targetIp, port);
  if (!socket || socket.state !== 'established') {
    return { ok: false, error: `Failed to connect to ${opts.targetIp} port ${port}: Connection refused` };
  }

  let response: HttpResponsePdu | null = null;
  const unsubscribe = socket.onData((data) => {
    try {
      const parsed = JSON.parse(String(data)) as unknown;
      if (isHttpResponsePdu(parsed)) response = parsed;
    } catch { /* ignore */ }
  });
  socket.write(JSON.stringify({
    type: 'http-request', method: opts.method ?? 'GET',
    path: opts.path ?? '/', headers: opts.headers ?? {},
  }));
  unsubscribe();
  socket.close();

  if (!response) return { ok: false, error: 'Empty reply from server' };
  return { ok: true, response };
}
