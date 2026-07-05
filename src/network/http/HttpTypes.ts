/**
 * HttpTypes — the HTTP/1.1 request/response shape hosted by the IIS role
 * (PRD-Windows-Server.md §5 P11). Follows the project's established
 * convention for application-layer protocols the PRD explicitly scopes
 * out of full binary wire fidelity (see §3 "PDU objets sur le transport
 * réel", the same convention `SmbServerHandler`/`SmbClient` use): a typed
 * PDU serialized as JSON text over a real `TcpConnection` — real TCP
 * handshake/routing/firewall/refused-connection semantics, RFC 9112
 * status-code/header semantics, but no hand-rolled HTTP/1.1 text framing.
 */

export interface HttpRequestPdu {
  readonly type: 'http-request';
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}

export interface HttpResponsePdu {
  readonly type: 'http-response';
  readonly statusCode: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.htm': 'text/html', '.html': 'text/html',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export function isHttpRequestPdu(v: unknown): v is HttpRequestPdu {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'http-request';
}

export function isHttpResponsePdu(v: unknown): v is HttpResponsePdu {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'http-response';
}
