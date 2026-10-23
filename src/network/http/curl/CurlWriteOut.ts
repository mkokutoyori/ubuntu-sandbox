export interface WriteOutHeader {
  readonly name: string;
  readonly value: string;
}

export interface WriteOutFacts {
  readonly httpCode: number;
  readonly httpConnect: number;
  readonly urlEffective: string;
  readonly inputUrl: string;
  readonly urlNum: number;
  readonly remoteIp: string | null;
  readonly remotePort: number;
  readonly localIp: string | null;
  readonly localPort: number;
  readonly sizeDownload: number;
  readonly sizeUpload: number;
  readonly sizeHeader: number;
  readonly sizeRequest: number;
  readonly contentType: string | null;
  readonly numRedirects: number;
  readonly numConnects: number;
  readonly numHeaders: number;
  readonly method: string;
  readonly scheme: string | null;
  readonly httpVersion: string;
  readonly exitCode: number;
  readonly errorMsg: string | null;
  readonly filenameEffective: string | null;
  readonly redirectUrl: string | null;
  readonly referer: string | null;
  readonly sslVerifyResult: number;
  readonly proxySslVerifyResult: number;
  readonly ftpEntryPath: string | null;
  readonly connId: number;
  readonly xferId: number;
  readonly timeNamelookup: number;
  readonly timeConnect: number;
  readonly timeAppconnect: number;
  readonly timePretransfer: number;
  readonly timeStarttransfer: number;
  readonly timeRedirect: number;
  readonly timeTotal: number;
  readonly speedDownload: number;
  readonly speedUpload: number;
  readonly headers: readonly WriteOutHeader[];
  readonly curlVersion: string;
}

export interface WriteOutFile {
  readonly path: string;
  readonly append: boolean;
  readonly content: string;
}

export interface WriteOutResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly files: readonly WriteOutFile[];
}

type Kind = 'string' | 'long' | 'offset' | 'time' | 'special';

interface Variable {
  readonly name: string;
  readonly kind: Kind;
  readonly value?: (facts: WriteOutFacts) => string | number | null;
}

type UrlPart = 'scheme' | 'user' | 'password' | 'options' | 'host' | 'port' | 'path' | 'query' | 'fragment' | 'zoneid';

const URL_PARTS: readonly UrlPart[] = ['scheme', 'user', 'password', 'options', 'host', 'port', 'path', 'query', 'fragment', 'zoneid'];
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443', ftp: '21' };
const HTTP_VERSIONS: Readonly<Record<string, string>> = { '1.0': '1', '1.1': '1.1', '2': '2', '3': '3' };
const ZERO_PADDED: ReadonlySet<string> = new Set(['http_code', 'response_code', 'http_connect']);

function urlPart(url: string, part: UrlPart): string | null {
  const match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?(?:([^:@/?#]*)(?::([^@/?#]*))?@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
  if (!match) return null;
  const scheme = (match[1] ?? 'http').toLowerCase();
  switch (part) {
    case 'scheme': return scheme;
    case 'user': return match[2] === undefined ? null : match[2];
    case 'password': return match[3] === undefined ? null : match[3];
    case 'host': return match[4].replace(/^\[|\]$/g, '') || null;
    case 'port': return match[5] ?? DEFAULT_PORTS[scheme] ?? null;
    case 'path': return match[6] === '' ? '/' : match[6];
    case 'query': return match[7] === undefined || match[7] === '' ? null : match[7];
    case 'fragment': return match[8] === undefined || match[8] === '' ? null : match[8];
    default: return null;
  }
}

function microseconds(value: number): string {
  const whole = Math.trunc(value / 1_000_000);
  return `${whole}.${String(Math.trunc(value % 1_000_000)).padStart(6, '0')}`;
}

const VARIABLES: readonly Variable[] = [
  { name: 'certs', kind: 'string', value: () => '' },
  { name: 'content_type', kind: 'string', value: (f) => f.contentType },
  { name: 'conn_id', kind: 'offset', value: (f) => f.connId },
  { name: 'errormsg', kind: 'string', value: (f) => (f.exitCode === 0 ? null : f.errorMsg) },
  { name: 'exitcode', kind: 'long', value: (f) => f.exitCode },
  { name: 'filename_effective', kind: 'string', value: (f) => f.filenameEffective },
  { name: 'ftp_entry_path', kind: 'string', value: (f) => f.ftpEntryPath },
  { name: 'header_json', kind: 'special' },
  { name: 'http_code', kind: 'long', value: (f) => f.httpCode },
  { name: 'http_connect', kind: 'long', value: (f) => f.httpConnect },
  { name: 'http_version', kind: 'string', value: (f) => HTTP_VERSIONS[f.httpVersion] ?? '0' },
  { name: 'json', kind: 'special' },
  { name: 'local_ip', kind: 'string', value: (f) => f.localIp },
  { name: 'local_port', kind: 'long', value: (f) => f.localPort },
  { name: 'method', kind: 'string', value: (f) => f.method },
  { name: 'num_certs', kind: 'long', value: () => 0 },
  { name: 'num_connects', kind: 'long', value: (f) => f.numConnects },
  { name: 'num_headers', kind: 'long', value: (f) => f.numHeaders },
  { name: 'num_redirects', kind: 'long', value: (f) => f.numRedirects },
  { name: 'onerror', kind: 'special' },
  { name: 'proxy_ssl_verify_result', kind: 'long', value: (f) => f.proxySslVerifyResult },
  { name: 'redirect_url', kind: 'string', value: (f) => f.redirectUrl },
  { name: 'referer', kind: 'string', value: (f) => f.referer },
  { name: 'remote_ip', kind: 'string', value: (f) => f.remoteIp },
  { name: 'remote_port', kind: 'long', value: (f) => f.remotePort },
  { name: 'response_code', kind: 'long', value: (f) => f.httpCode },
  { name: 'scheme', kind: 'string', value: (f) => f.scheme },
  { name: 'size_download', kind: 'offset', value: (f) => f.sizeDownload },
  { name: 'size_header', kind: 'long', value: (f) => f.sizeHeader },
  { name: 'size_request', kind: 'long', value: (f) => f.sizeRequest },
  { name: 'size_upload', kind: 'offset', value: (f) => f.sizeUpload },
  { name: 'speed_download', kind: 'offset', value: (f) => f.speedDownload },
  { name: 'speed_upload', kind: 'offset', value: (f) => f.speedUpload },
  { name: 'ssl_verify_result', kind: 'long', value: (f) => f.sslVerifyResult },
  { name: 'stderr', kind: 'special' },
  { name: 'stdout', kind: 'special' },
  { name: 'time_appconnect', kind: 'time', value: (f) => f.timeAppconnect },
  { name: 'time_connect', kind: 'time', value: (f) => f.timeConnect },
  { name: 'time_namelookup', kind: 'time', value: (f) => f.timeNamelookup },
  { name: 'time_pretransfer', kind: 'time', value: (f) => f.timePretransfer },
  { name: 'time_redirect', kind: 'time', value: (f) => f.timeRedirect },
  { name: 'time_starttransfer', kind: 'time', value: (f) => f.timeStarttransfer },
  { name: 'time_total', kind: 'time', value: (f) => f.timeTotal },
  { name: 'url', kind: 'string', value: (f) => f.inputUrl },
  ...URL_PARTS.map((part): Variable => ({ name: `url.${part}`, kind: 'string', value: (f) => urlPart(f.inputUrl, part) })),
  ...URL_PARTS.map((part): Variable => ({ name: `urle.${part}`, kind: 'string', value: (f) => urlPart(f.urlEffective, part) })),
  { name: 'url_effective', kind: 'string', value: (f) => f.urlEffective },
  { name: 'urlnum', kind: 'long', value: (f) => f.urlNum },
  { name: 'xfer_id', kind: 'offset', value: (f) => f.xferId },
];

function jsonQuoted(text: string, lowercase: boolean): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += lowercase ? ch.toLowerCase() : ch;
  }
  return `"${out}"`;
}

function plain(variable: Variable, facts: WriteOutFacts): string {
  const raw = variable.value?.(facts) ?? null;
  if (raw === null) return '';
  if (variable.kind === 'time') return microseconds(Number(raw));
  if (variable.kind === 'long' && ZERO_PADDED.has(variable.name)) return String(raw).padStart(3, '0');
  return String(raw);
}

function json(variable: Variable, facts: WriteOutFacts): string {
  const raw = variable.value?.(facts) ?? null;
  if (raw === null) return `"${variable.name}":null`;
  switch (variable.kind) {
    case 'string': return `"${variable.name}":${jsonQuoted(String(raw), false)}`;
    case 'time': return `"${variable.name}":${microseconds(Number(raw))}`;
    default: return `"${variable.name}":${String(raw)}`;
  }
}

function writeJson(facts: WriteOutFacts): string {
  const members = VARIABLES.filter((v) => v.kind !== 'special').map((v) => json(v, facts));
  return `{${members.join(',')},"curl_version":${jsonQuoted(facts.curlVersion, false)}}`;
}

function headerJson(facts: WriteOutFacts): string {
  const groups = new Map<string, string[]>();
  for (const { name, value } of facts.headers) {
    const key = name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  const entries = [...groups.entries()].map(([name, values]) =>
    `${jsonQuoted(name, true)}:[${values.map((v) => jsonQuoted(v, false)).join(',')}]`);
  return `{${entries.join(',\n')}\n}`;
}

type Sink = { kind: 'stdout' } | { kind: 'stderr' } | { kind: 'file'; path: string; append: boolean; content: string };

export function applyWriteOut(format: string, facts: WriteOutFacts): WriteOutResult {
  let stdout = '';
  let stderr = '';
  const files: WriteOutFile[] = [];
  let sink: Sink = { kind: 'stdout' };
  let done = false;

  const emit = (text: string): void => {
    if (sink.kind === 'stdout') stdout += text;
    else if (sink.kind === 'stderr') stderr += text;
    else sink.content += text;
  };
  const closeSink = (): void => {
    if (sink.kind === 'file') files.push({ path: sink.path, append: sink.append, content: sink.content });
  };

  let at = 0;
  while (at < format.length && !done) {
    const ch = format[at];
    const next = format[at + 1];
    if (ch === '%' && next !== undefined) {
      if (next === '%') {
        emit('%');
        at += 2;
      } else if (next === '{') {
        const end = format.indexOf('}', at);
        at += 2;
        if (end === -1) {
          emit('%{');
          continue;
        }
        const name = format.slice(at, end);
        const variable = VARIABLES.find((v) => v.name.toLowerCase() === name.toLowerCase());
        if (!variable) {
          stderr += `curl: unknown --write-out variable: '${name}'\n`;
        } else if (variable.name === 'onerror') {
          if (facts.exitCode === 0) done = true;
        } else if (variable.name === 'stdout' || variable.name === 'stderr') {
          closeSink();
          sink = { kind: variable.name };
        } else if (variable.name === 'json') {
          emit(writeJson(facts));
        } else if (variable.name === 'header_json') {
          emit(headerJson(facts));
        } else {
          emit(plain(variable, facts));
        }
        at = end + 1;
      } else if (format.startsWith('header{', at + 1)) {
        at += 8;
        const end = format.indexOf('}', at);
        if (end === -1) {
          emit('%header{');
          continue;
        }
        const wanted = format.slice(at, end).toLowerCase();
        if (end - at < 256) emit(facts.headers.find((h) => h.name.toLowerCase() === wanted)?.value ?? '');
        at = end + 1;
      } else if (format.startsWith('output{', at + 1)) {
        at += 8;
        const append = format.startsWith('>>', at);
        if (append) at += 2;
        const end = format.indexOf('}', at);
        if (end === -1) {
          emit('%output{');
          continue;
        }
        const path = format.slice(at, end);
        if (path.length < 512) {
          closeSink();
          sink = { kind: 'file', path, append, content: '' };
        }
        at = end + 1;
      } else {
        emit(`%${next}`);
        at += 2;
      }
    } else if (ch === '\\' && next !== undefined) {
      if (next === 'r') emit('\r');
      else if (next === 'n') emit('\n');
      else if (next === 't') emit('\t');
      else emit(`\\${next}`);
      at += 2;
    } else {
      emit(ch);
      at += 1;
    }
  }
  closeSink();
  return { stdout, stderr, files };
}
