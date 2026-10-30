import type { HttpMessage } from '@/network/http/semantics/types';
import { nginxReason } from './NginxStatus';

export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

type RangeParse =
  | { readonly kind: 'ok'; readonly spans: readonly ByteSpan[] }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'declined' };

export type RangeVerdict = 'untouched' | 'partial' | 'unsatisfiable';

const BOUNDARY_DIGITS = 20;
const NGINX_ETAG_QUOTE = '"';

export function parseNginxRange(header: string, contentLength: number): RangeParse {
  const text = header.slice(6);
  let at = 0;
  const spans: ByteSpan[] = [];
  let size = 0;
  const skipBlanks = (): void => { while (text[at] === ' ') at++; };
  const digits = (): number | null => {
    const from = at;
    while (at < text.length && text[at] >= '0' && text[at] <= '9') at++;
    return at === from ? null : Number(text.slice(from, at));
  };

  for (;;) {
    let start = 0;
    let end = 0;
    let suffix = false;
    skipBlanks();
    let openEnded = false;
    if (text[at] !== '-') {
      const first = digits();
      if (first === null) return { kind: 'unsatisfiable' };
      start = first;
      skipBlanks();
      if (text[at++] !== '-') return { kind: 'unsatisfiable' };
      skipBlanks();
      if (at >= text.length || text[at] === ',') {
        end = contentLength;
        openEnded = true;
      }
    } else {
      suffix = true;
      at++;
    }
    if (!openEnded) {
      const last = digits();
      if (last === null) return { kind: 'unsatisfiable' };
      end = last;
      skipBlanks();
      if (at < text.length && text[at] !== ',') return { kind: 'unsatisfiable' };
      if (suffix) {
        start = end < contentLength ? contentLength - end : 0;
        end = contentLength - 1;
      }
      end = end >= contentLength ? contentLength : end + 1;
    }
    if (start < end) {
      spans.push({ start, end });
      size += end - start;
    } else if (start === 0) {
      return { kind: 'declined' };
    }
    if (text[at++] !== ',') break;
  }
  if (spans.length === 0) return { kind: 'unsatisfiable' };
  if (size > contentLength) return { kind: 'declined' };
  return { kind: 'ok', spans };
}

function ifRangeAllows(req: HttpMessage, res: HttpMessage): boolean {
  const ifRange = req.headers.get('If-Range');
  if (ifRange === undefined) return true;
  if (ifRange.length >= 2 && ifRange.endsWith(NGINX_ETAG_QUOTE)) return res.headers.get('ETag') === ifRange;
  const lastModified = res.headers.get('Last-Modified');
  if (lastModified === undefined) return false;
  const asked = Date.parse(ifRange);
  return !Number.isNaN(asked) && Math.floor(asked / 1000) === Math.floor(Date.parse(lastModified) / 1000);
}

function ascending(spans: readonly ByteSpan[]): boolean {
  let last = 0;
  for (const span of spans) {
    if (span.start < last) return false;
    last = span.end;
  }
  return true;
}

export function applyRangeFilter(req: HttpMessage, res: HttpMessage, nextBoundary: () => number): RangeVerdict {
  if (res.statusCode !== 200 || res.body === null || res.headers.has('Transfer-Encoding')) return 'untouched';
  const advertise = (): RangeVerdict => { res.headers.set('Accept-Ranges', 'bytes'); return 'untouched'; };
  const range = req.headers.get('Range');
  if (range === undefined || range.length < 7 || range.slice(0, 6).toLowerCase() !== 'bytes=') return advertise();
  if (!ifRangeAllows(req, res)) return advertise();

  const body = res.body;
  const parsed = parseNginxRange(range, body.length);
  if (parsed.kind === 'unsatisfiable') return 'unsatisfiable';
  if (parsed.kind === 'declined') return advertise();
  const { spans } = parsed;

  res.statusCode = 206;
  res.reasonPhrase = nginxReason(206);
  res.headers.delete('Content-Length');
  if (spans.length === 1) {
    const [{ start, end }] = spans;
    res.headers.set('Content-Range', `bytes ${start}-${end - 1}/${body.length}`);
    res.body = body.slice(start, end);
    return 'partial';
  }
  if (!ascending(spans)) {
    res.statusCode = 200;
    res.reasonPhrase = nginxReason(200);
    return advertise();
  }

  const boundary = String(nextBoundary()).padStart(BOUNDARY_DIGITS, '0');
  const type = res.headers.get('Content-Type');
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const { start, end } of spans) {
    const head = `\r\n--${boundary}\r\n${type === undefined ? '' : `Content-Type: ${type}\r\n`}Content-Range: bytes ${start}-${end - 1}/${body.length}\r\n\r\n`;
    parts.push(encoder.encode(head), body.slice(start, end));
  }
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  res.body = joined;
  res.headers.set('Content-Type', `multipart/byteranges; boundary=${boundary}`);
  res.headers.delete('Content-Range');
  return 'partial';
}
