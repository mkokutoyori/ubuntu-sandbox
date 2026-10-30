const STATUS_LINES: Readonly<Record<number, string>> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Moved Temporarily', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Not Allowed', 406: 'Not Acceptable', 408: 'Request Time-out',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed',
  413: 'Request Entity Too Large', 414: 'Request-URI Too Large', 415: 'Unsupported Media Type',
  416: 'Requested Range Not Satisfiable', 421: 'Misdirected Request', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Temporarily Unavailable', 504: 'Gateway Time-out', 505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
};

interface ErrorPage {
  readonly title: string;
  readonly heading: string;
  readonly detail?: string;
}

const same = (text: string): ErrorPage => ({ title: text, heading: text });

const ERROR_PAGES: Readonly<Record<number, ErrorPage>> = {
  301: same('301 Moved Permanently'), 302: same('302 Found'), 303: same('303 See Other'),
  307: same('307 Temporary Redirect'), 308: same('308 Permanent Redirect'),
  400: same('400 Bad Request'), 401: same('401 Authorization Required'), 402: same('402 Payment Required'),
  403: same('403 Forbidden'), 404: same('404 Not Found'), 405: same('405 Not Allowed'),
  406: same('406 Not Acceptable'), 408: same('408 Request Time-out'), 409: same('409 Conflict'),
  410: same('410 Gone'), 411: same('411 Length Required'), 412: same('412 Precondition Failed'),
  413: same('413 Request Entity Too Large'), 414: same('414 Request-URI Too Large'),
  415: same('415 Unsupported Media Type'), 416: same('416 Requested Range Not Satisfiable'),
  421: same('421 Misdirected Request'), 429: same('429 Too Many Requests'),
  494: { title: '400 Request Header Or Cookie Too Large', heading: '400 Bad Request', detail: 'Request Header Or Cookie Too Large' },
  495: { title: '400 The SSL certificate error', heading: '400 Bad Request', detail: 'The SSL certificate error' },
  496: { title: '400 No required SSL certificate was sent', heading: '400 Bad Request', detail: 'No required SSL certificate was sent' },
  497: { title: '400 The plain HTTP request was sent to HTTPS port', heading: '400 Bad Request', detail: 'The plain HTTP request was sent to HTTPS port' },
  500: same('500 Internal Server Error'), 501: same('501 Not Implemented'), 502: same('502 Bad Gateway'),
  503: same('503 Service Temporarily Unavailable'), 504: same('504 Gateway Time-out'),
  505: same('505 HTTP Version Not Supported'), 507: same('507 Insufficient Storage'),
};

export function nginxReason(status: number): string {
  return STATUS_LINES[status] ?? '';
}

export function errorPage(status: number, version: string): string | null {
  const page = ERROR_PAGES[status];
  if (page === undefined) return null;
  const detail = page.detail === undefined ? '' : `<center>${page.detail}</center>\r\n`;
  return `<html>\r\n<head><title>${page.title}</title></head>\r\n<body>\r\n<center><h1>${page.heading}</h1></center>\r\n${detail}<hr><center>nginx/${version}</center>\r\n</body>\r\n</html>\r\n`;
}
