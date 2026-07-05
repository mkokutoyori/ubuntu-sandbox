import type { HttpMethod } from './types';

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

export function statusClassOf(code: number): StatusClass {
  const first = Math.floor(code / 100);
  if (first < 1 || first > 5) throw new Error(`Invalid HTTP status code: ${code}`);
  return `${first}xx` as StatusClass;
}

// RFC 9110 §15 — reason phrases for the codes this engine actually emits/parses.
export const REASON_PHRASES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export function reasonPhraseFor(code: number): string {
  return REASON_PHRASES[code] ?? statusClassOf(code).toUpperCase();
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(code: number): boolean {
  return REDIRECT_CODES.has(code);
}

/**
 * RFC 9110 §15.4 method/body preservation rules on redirect. 303 always
 * downgrades to GET; 301/302 only downgrade a POST to GET (the long-standing
 * de-facto behavior codified by §15.4.2/§15.4.3, matched by curl/browsers);
 * 307/308 always preserve method and body.
 */
export function redirectMethodFor(originalMethod: HttpMethod, statusCode: number): HttpMethod {
  if (!isRedirectStatus(statusCode)) throw new Error(`Not a redirect status: ${statusCode}`);
  if (statusCode === 303) return originalMethod === 'HEAD' ? 'HEAD' : 'GET';
  if (statusCode === 301 || statusCode === 302) return originalMethod === 'POST' ? 'GET' : originalMethod;
  return originalMethod;
}

export function redirectPreservesBody(originalMethod: HttpMethod, statusCode: number): boolean {
  return redirectMethodFor(originalMethod, statusCode) === originalMethod;
}
