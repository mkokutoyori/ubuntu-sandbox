import { OrderedMultimap, type HttpMessage, type HttpMethod } from '../semantics/types';
import { reasonPhraseFor } from '../semantics/statusCodes';

const CRLF = '\r\n';

// A body is arbitrary bytes (RFC 9112 doesn't require it to be text at
// all — e.g. `application/dns-message`, images, or any other binary media
// type), so it's carried through this module one byte per JS string
// character rather than through a real UTF-8 `TextEncoder`/`TextDecoder`
// round-trip: the latter is lossy for any byte sequence that isn't valid
// UTF-8 (silently replaced with U+FFFD), which would corrupt binary
// bodies. For pure-ASCII bodies (the common case in this project's own
// tests) the two conventions are byte-for-byte identical, so this is a
// strict superset fix, not a behavior change for existing callers.
function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export interface Http1EncodeOptions {
  chunked?: boolean;
}

export interface Http1ParseError {
  ok: false;
  status: 400;
  reason: string;
}

export interface Http1ParseSuccess {
  ok: true;
  message: HttpMessage;
}

export type Http1ParseResult = Http1ParseSuccess | Http1ParseError;

function bodyTextOf(msg: HttpMessage): string {
  return msg.body ? bytesToBinaryString(msg.body) : '';
}

function encodeHead(startLine: string, headers: OrderedMultimap<string>, bodyText: string, opts?: Http1EncodeOptions): string {
  const out = new OrderedMultimap<string>();
  for (const [k, v] of headers.entries()) out.append(k, v);

  let payload = bodyText;
  if (opts?.chunked) {
    out.delete('Content-Length');
    out.set('Transfer-Encoding', 'chunked');
    payload = encodeChunkedBody([bodyText]);
  } else {
    out.delete('Transfer-Encoding');
    out.set('Content-Length', String(bodyText.length));
  }

  const lines = [startLine, ...out.entries().map(([k, v]) => `${k}: ${v}`)];
  return lines.join(CRLF) + CRLF + CRLF + payload;
}

export function encodeRequest(msg: HttpMessage, opts?: Http1EncodeOptions): string {
  if (msg.kind !== 'request' || !msg.method || msg.target === undefined) {
    throw new Error('encodeRequest requires a request-kind HttpMessage with method and target');
  }
  const startLine = `${msg.method} ${msg.target} HTTP/${msg.httpVersion}`;
  return encodeHead(startLine, msg.headers, bodyTextOf(msg), opts);
}

export function encodeResponse(msg: HttpMessage, opts?: Http1EncodeOptions): string {
  if (msg.kind !== 'response' || msg.statusCode === undefined) {
    throw new Error('encodeResponse requires a response-kind HttpMessage with a statusCode');
  }
  const reason = msg.reasonPhrase ?? reasonPhraseFor(msg.statusCode);
  const startLine = `HTTP/${msg.httpVersion} ${msg.statusCode} ${reason}`;
  return encodeHead(startLine, msg.headers, bodyTextOf(msg), opts);
}

// RFC 9112 §7.1 — chunk-size (hex) CRLF, chunk-data CRLF, repeated, then a
// zero-size chunk, optional trailer fields, final CRLF.
export function encodeChunkedBody(chunks: string[], trailers?: OrderedMultimap<string>): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    const size = chunk.length;
    parts.push(size.toString(16) + CRLF + chunk + CRLF);
  }
  parts.push('0' + CRLF);
  if (trailers) {
    for (const [k, v] of trailers.entries()) parts.push(`${k}: ${v}${CRLF}`);
  }
  parts.push(CRLF);
  return parts.join('');
}

export interface DecodedChunkedBody {
  body: string;
  trailers: OrderedMultimap<string>;
}

export function decodeChunkedBody(text: string): DecodedChunkedBody | null {
  let offset = 0;
  let body = '';
  for (;;) {
    const lineEnd = text.indexOf(CRLF, offset);
    if (lineEnd === -1) return null;
    const sizeLine = text.slice(offset, lineEnd).split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeLine)) return null;
    const size = parseInt(sizeLine, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      const trailers = new OrderedMultimap<string>();
      let rest = text.slice(offset);
      while (rest !== CRLF) {
        const idx = rest.indexOf(CRLF);
        if (idx === -1) return null;
        const line = rest.slice(0, idx);
        if (line === '') { rest = rest.slice(idx + 2); break; }
        const colon = line.indexOf(':');
        if (colon === -1) return null;
        trailers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        rest = rest.slice(idx + 2);
      }
      return { body, trailers };
    }
    const chunkData = text.slice(offset, offset + size);
    if (chunkData.length !== size) return null;
    body += chunkData;
    offset += size;
    if (text.slice(offset, offset + 2) !== CRLF) return null;
    offset += 2;
  }
}

function parseHeaderLines(lines: string[]): OrderedMultimap<string> | null {
  const headers = new OrderedMultimap<string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

interface ParsedHead {
  startLine: string;
  headers: OrderedMultimap<string>;
  rest: string;
}

function splitHeadSection(raw: string): ParsedHead | null {
  const idx = raw.indexOf(CRLF + CRLF);
  if (idx === -1) return null;
  const [startLine, ...headerLines] = raw.slice(0, idx).split(CRLF);
  const headers = parseHeaderLines(headerLines);
  if (!headers) return null;
  return { startLine, headers, rest: raw.slice(idx + 4) };
}

/**
 * RFC 9112 §6.3 — a message carrying both Content-Length and
 * Transfer-Encoding is rejected outright (this endpoint never acts as an
 * intermediary that could safely strip one), guarding against the framing
 * ambiguity behind request/response smuggling.
 */
function resolveBody(headers: OrderedMultimap<string>, rest: string, suppressBody: boolean): { body: string } | Http1ParseError {
  const hasContentLength = headers.has('Content-Length');
  const transferEncoding = headers.get('Transfer-Encoding');
  if (hasContentLength && transferEncoding !== undefined) {
    return { ok: false, status: 400, reason: 'Content-Length and Transfer-Encoding both present' };
  }
  if (suppressBody) return { body: '' };

  if (transferEncoding !== undefined) {
    if (transferEncoding.toLowerCase() !== 'chunked') {
      return { ok: false, status: 400, reason: `Unsupported Transfer-Encoding: ${transferEncoding}` };
    }
    const decoded = decodeChunkedBody(rest);
    if (!decoded) return { ok: false, status: 400, reason: 'Malformed chunked body' };
    for (const [k, v] of decoded.trailers.entries()) headers.append(k, v);
    return { body: decoded.body };
  }

  if (hasContentLength) {
    const length = parseInt(headers.get('Content-Length') as string, 10);
    if (isNaN(length) || length < 0) return { ok: false, status: 400, reason: 'Invalid Content-Length' };
    if (rest.length < length) return { ok: false, status: 400, reason: 'Truncated body' };
    if (rest.length > length) return { ok: false, status: 400, reason: 'Trailing data after body' };
    return { body: rest.slice(0, length) };
  }

  if (rest.length > 0) return { ok: false, status: 400, reason: 'Unexpected body with no Content-Length/Transfer-Encoding' };
  return { body: '' };
}

const KNOWN_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);

export function parseRequest(raw: string): Http1ParseResult {
  const head = splitHeadSection(raw);
  if (!head) return { ok: false, status: 400, reason: 'Malformed request head' };
  const parts = head.startLine.split(' ');
  if (parts.length !== 3) return { ok: false, status: 400, reason: 'Malformed request-line' };
  const [method, target, version] = parts;
  if (!KNOWN_METHODS.has(method as HttpMethod)) return { ok: false, status: 400, reason: `Unknown method: ${method}` };
  const versionMatch = /^HTTP\/(1\.1|1\.0)$/.exec(version);
  if (!versionMatch) return { ok: false, status: 400, reason: `Unsupported version: ${version}` };

  // RFC 9112 §6 — a REQUEST's framing comes from Transfer-Encoding /
  // Content-Length, never from the method. Suppressing by verb is the rule
  // for a RESPONSE to HEAD (§6.3, and `parseResponse`'s `suppressBody`
  // below), and applying it here silently dropped the body of a
  // `curl -X GET -d …`, which real curl does send. A GET carrying no
  // Content-Length still parses to no body, and a body with no length is
  // still the 400 it always was — `resolveBody` decides both.
  const bodyResult = resolveBody(head.headers, head.rest, false);
  if ('ok' in bodyResult) return bodyResult;

  return {
    ok: true,
    message: {
      kind: 'request',
      method: method as HttpMethod,
      target,
      headers: head.headers,
      body: bodyResult.body.length > 0 ? binaryStringToBytes(bodyResult.body) : null,
      httpVersion: '1.1',
    },
  };
}

export interface Http1ParseResponseOptions {
  /** Response to a HEAD request, or a 1xx/204/304 status — never has a body regardless of headers (RFC 9110 §6.4.1). */
  suppressBody?: boolean;
}

export function parseResponse(raw: string, opts?: Http1ParseResponseOptions): Http1ParseResult {
  const head = splitHeadSection(raw);
  if (!head) return { ok: false, status: 400, reason: 'Malformed response head' };
  const m = /^HTTP\/(1\.1|1\.0) (\d{3}) (.*)$/.exec(head.startLine);
  if (!m) return { ok: false, status: 400, reason: 'Malformed status-line' };
  const statusCode = parseInt(m[2], 10);
  const reasonPhrase = m[3];

  const suppressBody = opts?.suppressBody ?? (statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200));
  const bodyResult = resolveBody(head.headers, head.rest, suppressBody);
  if ('ok' in bodyResult) return bodyResult;

  return {
    ok: true,
    message: {
      kind: 'response',
      statusCode,
      reasonPhrase,
      headers: head.headers,
      body: bodyResult.body.length > 0 ? binaryStringToBytes(bodyResult.body) : null,
      httpVersion: '1.1',
    },
  };
}
