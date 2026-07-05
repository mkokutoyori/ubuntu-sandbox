/**
 * HttpFetch — shared real-HTTP-dial helper for `curl`/`wget`
 * (PRD-Windows-Server.md §5 P11 acceptance criterion: `curl http://
 * srv1.lab.local/` from a Linux client must reach a real IIS-hosted
 * site). Resolves the hostname via the real NSS `hosts: files dns`
 * chain, then dials the real per-device `TcpStack` — same wire client
 * `dialHttp` uses for `Invoke-WebRequest` on Windows.
 */

import type { LinuxCommandContext } from '../LinuxCommandContext';
import { dialHttp, parseHttpUrl, type HttpDialResult } from '@/network/http/HttpClient';

export type HttpFetchResult =
  | { ok: true; host: string; port: number; response: NonNullable<HttpDialResult['response']> }
  | { ok: false; reason: 'bad-url' | 'unresolved-host' | 'refused'; host?: string; port?: number };

export function fetchHttp(ctx: LinuxCommandContext, url: string): HttpFetchResult {
  const parsed = parseHttpUrl(url);
  if (!parsed) return { ok: false, reason: 'bad-url' };
  const ip = ctx.net.resolveHostnameSync(parsed.host);
  if (!ip) return { ok: false, reason: 'unresolved-host', host: parsed.host, port: parsed.port };
  const result = dialHttp({
    tcpStack: ctx.net.getTcpStack(), targetIp: ip.toString(), port: parsed.port, path: parsed.path,
  });
  if (!result.ok || !result.response) return { ok: false, reason: 'refused', host: parsed.host, port: parsed.port };
  return { ok: true, host: parsed.host, port: parsed.port, response: result.response };
}
