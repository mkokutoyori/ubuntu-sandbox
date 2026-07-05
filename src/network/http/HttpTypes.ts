/**
 * HttpTypes — shared IIS/curl/`Invoke-WebRequest` helpers
 * (PRD-Windows-Server.md §5 P11). `HttpClient.ts`/`WindowsIisRole.ts` were
 * migrated onto the real RFC 9112 engine (`http1/`) by `PRD-HTTP.md` §5
 * P12 — `HttpResponsePdu` survives only as the public response shape
 * `dialHttp()` still returns (unchanged signature for its callers,
 * `HttpFetch.ts`/`Curl.ts`/`WindowsPC.invokeWebRequest`); the JSON-PDU
 * wire format itself (`HttpRequestPdu`, `isHttpRequestPdu`/
 * `isHttpResponsePdu`) is gone.
 */

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
