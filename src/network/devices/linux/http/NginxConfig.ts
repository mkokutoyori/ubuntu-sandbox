import { NGINX_CONF_PATH } from './NginxFiles';

export interface NginxToken {
  readonly value: string;
  readonly line: number;
  readonly file: string;
  readonly punct?: '{' | '}' | ';';
}

export interface NginxDirective {
  readonly name: string;
  readonly args: readonly string[];
  readonly line: number;
  readonly file: string;
  readonly block?: readonly NginxDirective[];
}

export interface NginxConfigError {
  readonly message: string;
}

export type NginxParseResult =
  | { ok: true; tree: readonly NginxDirective[] }
  | { ok: false; error: NginxConfigError };

export interface NginxFileSource {
  read(path: string): string | null;
  list(dir: string): string[] | null;
}

const APPLIED_BLOCKS = new Set(['http', 'server', 'location', 'events', 'if']);

const APPLIED_DIRECTIVES = new Set([
  'listen', 'server_name', 'root', 'index', 'try_files', 'return',
  'error_page', 'autoindex', 'access_log', 'error_log', 'include',
  'add_header', 'default_type',
]);

/**
 * Directives sans effet observable ici, acceptées quand même.
 *
 * C'est l'exception assumée au principe P1 (docs/PRD-Nginx.md §5) : elles
 * décrivent un ordonnancement, un réglage de tampon ou une compression que
 * ce simulateur ne modélise pas. Les refuser rendrait invalide tout
 * `nginx.conf` réel, à commencer par celui que Debian livre — le refus
 * coûterait plus de vérité qu'il n'en apporterait.
 */
const ACCEPTED_INERT = new Set([
  'user', 'pid', 'worker_processes', 'worker_connections', 'worker_rlimit_nofile',
  'multi_accept', 'sendfile', 'tcp_nopush', 'tcp_nodelay', 'keepalive_timeout',
  'keepalive_requests', 'types_hash_max_size', 'server_tokens', 'server_names_hash_bucket_size',
  'client_max_body_size', 'client_body_timeout', 'client_header_timeout', 'send_timeout',
  'gzip', 'gzip_disable', 'gzip_vary', 'gzip_proxied', 'gzip_comp_level',
  'gzip_buffers', 'gzip_http_version', 'gzip_types', 'gzip_min_length',
  'log_format', 'charset', 'etag', 'expires', 'error_page_recursive',
  'reset_timedout_connection', 'open_file_cache', 'aio', 'directio',
]);

/**
 * Connues de nginx, avec un effet réel que cette version ne sait pas
 * produire. Refusées en le disant — jamais avalées, jamais confondues avec
 * une faute de frappe.
 */
const KNOWN_UNSUPPORTED = new Set([
  'proxy_pass', 'proxy_set_header', 'proxy_redirect', 'proxy_buffering',
  'proxy_read_timeout', 'proxy_connect_timeout', 'upstream',
  'fastcgi_pass', 'fastcgi_param', 'fastcgi_index', 'include_fastcgi',
  'rewrite', 'limit_req', 'limit_req_zone', 'limit_conn', 'limit_conn_zone',
  'auth_basic', 'auth_basic_user_file', 'ssl_certificate', 'ssl_certificate_key',
  'ssl_protocols', 'ssl_ciphers', 'ssl_prefer_server_ciphers', 'ssl_session_cache',
  'ssl_session_timeout', 'ssl_dhparam', 'stub_status', 'sub_filter',
  'geo', 'map', 'split_clients', 'perl', 'lua_package_path',
]);

function emerg(message: string, file: string, line: number): NginxConfigError {
  return { message: `nginx: [emerg] ${message} in ${file}:${line}` };
}

function tokenize(text: string, file: string): NginxToken[] {
  const tokens: NginxToken[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === ';') {
      tokens.push({ value: ch, line, file, punct: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let out = '';
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\n') line++;
        out += text[i];
        i++;
      }
      i++;
      tokens.push({ value: out, line, file });
      continue;
    }
    let word = '';
    while (i < text.length && !' \t\r\n{};#'.includes(text[i])) {
      word += text[i];
      i++;
    }
    tokens.push({ value: word, line, file });
  }
  return tokens;
}

function globMatch(pattern: string, name: string): boolean {
  const rx = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(name);
}

function resolveInclude(source: NginxFileSource, pattern: string): string[] {
  if (!pattern.includes('*')) {
    return source.read(pattern) === null ? [] : [pattern];
  }
  const slash = pattern.lastIndexOf('/');
  const dir = pattern.slice(0, slash) || '/';
  const glob = pattern.slice(slash + 1);
  const entries = source.list(dir);
  if (!entries) return [];
  return entries
    .filter((e) => globMatch(glob, e))
    .sort()
    .map((e) => `${dir}/${e}`);
}

interface ParseState {
  tokens: NginxToken[];
  pos: number;
}

function parseBlock(
  state: ParseState,
  source: NginxFileSource,
  depth: number,
  seen: Set<string>,
): NginxParseResult {
  const out: NginxDirective[] = [];

  for (;;) {
    const token = state.tokens[state.pos];
    if (token === undefined) {
      if (depth === 0) return { ok: true, tree: out };
      const last = state.tokens[state.tokens.length - 1];
      return {
        ok: false,
        error: emerg('unexpected end of file, expecting "}"', last?.file ?? NGINX_CONF_PATH, last?.line ?? 1),
      };
    }

    if (token.punct === '}') {
      if (depth === 0) {
        return { ok: false, error: emerg('unexpected "}"', token.file, token.line) };
      }
      state.pos++;
      return { ok: true, tree: out };
    }

    if (token.punct === ';' || token.punct === '{') {
      return { ok: false, error: emerg(`unexpected "${token.value}"`, token.file, token.line) };
    }

    const name = token.value;
    const line = token.line;
    const file = token.file;
    state.pos++;

    const args: string[] = [];
    for (;;) {
      const next = state.tokens[state.pos];
      if (next === undefined) {
        return { ok: false, error: emerg('unexpected end of file, expecting ";" or "}"', file, line) };
      }
      if (next.punct === ';' || next.punct === '{') break;
      if (next.punct === '}') {
        return { ok: false, error: emerg('unexpected "}"', next.file, next.line) };
      }
      args.push(next.value);
      state.pos++;
    }

    const terminator = state.tokens[state.pos];

    if (terminator.punct === '{') {
      if (!APPLIED_BLOCKS.has(name)) {
        return { ok: false, error: unknownOrUnsupported(name, file, line) };
      }
      state.pos++;
      const inner = parseBlock(state, source, depth + 1, seen);
      if (inner.ok === false) return inner;
      out.push({ name, args, line, file, block: inner.tree });
      continue;
    }

    state.pos++;

    if (name === 'include') {
      if (args.length !== 1) {
        return { ok: false, error: emerg('invalid number of arguments in "include" directive', file, line) };
      }
      for (const path of resolveInclude(source, args[0])) {
        if (seen.has(path)) continue;
        seen.add(path);
        const text = source.read(path);
        if (text === null) continue;
        const nested = parseBlock({ tokens: tokenize(text, path), pos: 0 }, source, 0, seen);
        if (nested.ok === false) return nested;
        out.push(...nested.tree);
      }
      continue;
    }

    if (!APPLIED_DIRECTIVES.has(name) && !ACCEPTED_INERT.has(name)) {
      return { ok: false, error: unknownOrUnsupported(name, file, line) };
    }

    out.push({ name, args, line, file });
  }
}

function unknownOrUnsupported(name: string, file: string, line: number): NginxConfigError {
  if (KNOWN_UNSUPPORTED.has(name)) {
    return emerg(`directive "${name}" is not supported by this simulator`, file, line);
  }
  return emerg(`unknown directive "${name}"`, file, line);
}

export function parseNginxConfig(source: NginxFileSource, path = NGINX_CONF_PATH): NginxParseResult {
  const text = source.read(path);
  if (text === null) {
    return {
      ok: false,
      error: { message: `nginx: [emerg] open() "${path}" failed (2: No such file or directory)` },
    };
  }
  return parseBlock({ tokens: tokenize(text, path), pos: 0 }, source, 0, new Set([path]));
}

// ─── Modèle exploité par le serveur ────────────────────────────────────

export interface NginxLocation {
  readonly path: string;
  readonly root?: string;
  readonly index?: readonly string[];
  readonly tryFiles?: readonly string[];
  readonly returnStatus?: number;
  readonly returnTarget?: string;
  readonly autoindex?: boolean;
  readonly addHeaders: readonly (readonly [string, string])[];
}

export interface NginxServerBlock {
  readonly listen: readonly { port: number; defaultServer: boolean; ssl: boolean }[];
  readonly serverNames: readonly string[];
  readonly root: string;
  readonly index: readonly string[];
  readonly locations: readonly NginxLocation[];
  readonly accessLog: string | null;
  readonly errorLog: string | null;
  readonly addHeaders: readonly (readonly [string, string])[];
}

function parseListen(args: readonly string[]): { port: number; defaultServer: boolean; ssl: boolean } | null {
  if (args.length === 0) return null;
  const first = args[0];
  const ipv6 = /^\[.*\]:(\d+)$/.exec(first);
  const hostPort = /^[\d.]+:(\d+)$/.exec(first);
  const bare = /^(\d+)$/.exec(first);
  const port = ipv6 ? Number(ipv6[1]) : hostPort ? Number(hostPort[1]) : bare ? Number(bare[1]) : NaN;
  if (!Number.isInteger(port)) return null;
  return {
    port,
    defaultServer: args.includes('default_server'),
    ssl: args.includes('ssl'),
  };
}

function collectLocation(node: NginxDirective, inheritedRoot: string): NginxLocation {
  const loc: {
    path: string; root?: string; index?: string[]; tryFiles?: string[];
    returnStatus?: number; returnTarget?: string; autoindex?: boolean;
    addHeaders: (readonly [string, string])[];
  } = { path: node.args[node.args.length - 1] ?? '/', addHeaders: [] };

  for (const d of node.block ?? []) {
    if (d.name === 'root') loc.root = d.args[0];
    else if (d.name === 'index') loc.index = [...d.args];
    else if (d.name === 'try_files') loc.tryFiles = [...d.args];
    else if (d.name === 'autoindex') loc.autoindex = d.args[0] === 'on';
    else if (d.name === 'add_header' && d.args.length >= 2) loc.addHeaders.push([d.args[0], d.args[1]]);
    else if (d.name === 'return') {
      const status = Number(d.args[0]);
      if (Number.isInteger(status)) {
        loc.returnStatus = status;
        loc.returnTarget = d.args[1];
      }
    }
  }
  if (!loc.root) loc.root = inheritedRoot;
  return loc as NginxLocation;
}

function collectServer(node: NginxDirective, httpDefaults: { accessLog: string | null; errorLog: string | null }): NginxServerBlock {
  const listen: { port: number; defaultServer: boolean; ssl: boolean }[] = [];
  let serverNames: string[] = [];
  let root = '/var/www/html';
  let index: string[] = ['index.html'];
  let accessLog = httpDefaults.accessLog;
  let errorLog = httpDefaults.errorLog;
  const locations: NginxLocation[] = [];
  const addHeaders: (readonly [string, string])[] = [];

  for (const d of node.block ?? []) {
    if (d.name === 'listen') {
      const spec = parseListen(d.args);
      if (spec && !listen.some((l) => l.port === spec.port)) listen.push(spec);
    } else if (d.name === 'server_name') serverNames = [...d.args];
    else if (d.name === 'root') root = d.args[0] ?? root;
    else if (d.name === 'index') index = [...d.args];
    else if (d.name === 'access_log') accessLog = d.args[0] === 'off' ? null : (d.args[0] ?? accessLog);
    else if (d.name === 'error_log') errorLog = d.args[0] ?? errorLog;
    else if (d.name === 'add_header' && d.args.length >= 2) addHeaders.push([d.args[0], d.args[1]]);
  }
  for (const d of node.block ?? []) {
    if (d.name === 'location') locations.push(collectLocation(d, root));
  }

  return { listen, serverNames, root, index, locations, accessLog, errorLog, addHeaders };
}

export function extractServers(tree: readonly NginxDirective[]): NginxServerBlock[] {
  const out: NginxServerBlock[] = [];
  const defaults = { accessLog: null as string | null, errorLog: null as string | null };

  const walk = (nodes: readonly NginxDirective[], inHttp: boolean): void => {
    for (const node of nodes) {
      if (node.name === 'access_log' && !inHttp) defaults.accessLog = node.args[0] === 'off' ? null : node.args[0];
      if (node.name === 'error_log' && !inHttp) defaults.errorLog = node.args[0];
      if (node.name === 'http') {
        for (const d of node.block ?? []) {
          if (d.name === 'access_log') defaults.accessLog = d.args[0] === 'off' ? null : d.args[0];
          if (d.name === 'error_log') defaults.errorLog = d.args[0];
        }
        walk(node.block ?? [], true);
      } else if (node.name === 'server') {
        out.push(collectServer(node, defaults));
      }
    }
  };

  walk(tree, false);
  return out;
}
