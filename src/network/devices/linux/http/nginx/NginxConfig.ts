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

const APPLIED_BLOCKS = new Set(['http', 'server', 'location', 'events', 'if', 'upstream']);

const APPLIED_DIRECTIVES = new Set([
  'listen', 'server_name', 'root', 'index', 'try_files', 'return',
  'error_page', 'autoindex', 'access_log', 'error_log', 'include',
  'add_header', 'default_type',
  // §P5 — these two DECIDE which certificate a `listen … ssl` port
  // presents, so they belong here and not in `ACCEPTED_INERT`.
  'ssl_certificate', 'ssl_certificate_key',
  // §P6 — `proxy_pass` DÉCIDE vers où la requête part, `proxy_set_header`
  // ce qu'elle emporte, et `server` (dans un bloc `upstream`) nomme la
  // cible. Les trois agissent ; elles ne peuvent pas être inertes.
  'proxy_pass', 'proxy_set_header',
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
  // §P6 — réglages du mandataire sans effet observable ici : le temps
  // n'existe pas (la livraison des trames est synchrone), donc aucun
  // délai ne peut expirer, et il n'y a pas de tampon à dimensionner.
  'proxy_buffering', 'proxy_buffers', 'proxy_buffer_size', 'proxy_redirect',
  'proxy_read_timeout', 'proxy_connect_timeout', 'proxy_send_timeout',
  'proxy_http_version', 'proxy_next_upstream', 'keepalive',
]);

/**
 * Connues de nginx, avec un effet réel que cette version ne sait pas
 * produire. Refusées en le disant — jamais avalées, jamais confondues avec
 * une faute de frappe.
 */
const KNOWN_UNSUPPORTED = new Set([
  // `proxy_pass`, `proxy_set_header` et le bloc `upstream` ont quitté
  // cette liste : docs/PRD-Nginx.md §P6 les IMPLÉMENTE.
  'fastcgi_pass', 'fastcgi_param', 'fastcgi_index', 'include_fastcgi',
  'rewrite', 'limit_req', 'limit_req_zone', 'limit_conn', 'limit_conn_zone',
  'auth_basic', 'auth_basic_user_file',
  // `ssl_certificate`/`ssl_certificate_key` are IMPLEMENTED since
  // docs/PRD-Nginx.md §P5 and no longer belong here. The remaining
  // `ssl_*` are handshake knobs: this TLS engine picks its own suite and
  // groups, so accepting them would store a value nothing reads — the
  // same rule this file applies to every other directive.
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

/**
 * §P6 — `server` a deux sens chez nginx selon l'endroit : un BLOC qui
 * décrit un site, et une DIRECTIVE qui nomme un membre d'`upstream`.
 * Les distinguer demande de savoir dans quel bloc on se trouve, d'où ce
 * paramètre : sans lui, accepter `server 10.0.0.2:8080;` partout
 * laisserait passer au niveau `http` une ligne que nginx refuse.
 */
function parseBlock(
  state: ParseState,
  source: NginxFileSource,
  depth: number,
  seen: Set<string>,
  parent: string | null = null,
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
      const inner = parseBlock(state, source, depth + 1, seen, name);
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

    // `proxy_pass` n'a de sens que dans une `location` : c'est elle qui
    // dit QUELLES requêtes partent vers l'amont. Écrite dans un `server`,
    // nginx la refuse — et le refus doit être celui-là, pas
    // « not supported », maintenant que le simulateur la met en œuvre.
    if (name === 'proxy_pass' && parent !== 'location' && parent !== 'if') {
      return { ok: false, error: emerg('"proxy_pass" directive is not allowed here', file, line) };
    }
    if (parent === 'upstream' && name === 'server') {
      if (args.length === 0) {
        return { ok: false, error: emerg('invalid number of arguments in "server" directive', file, line) };
      }
      out.push({ name, args, line, file });
      continue;
    }
    if (name === 'server') {
      // Hors d'un `upstream`, `server` est un bloc. Le message est celui
      // de nginx pour une directive écrite là où elle n'a pas cours,
      // et non « unknown directive » : nginx la connaît très bien.
      return { ok: false, error: emerg('"server" directive is not allowed here', file, line) };
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

/**
 * Ce que nginx exige au-delà de la syntaxe. Une configuration vide est
 * syntaxiquement correcte et pourtant refusée : sans section `events`, le
 * démon n'a pas de modèle de connexions et sort. C'est ce qui distingue un
 * `nginx.conf` VIDE d'un `nginx.conf` ABSENT (docs/PRD-Nginx.md §P3).
 */
export function validateNginxConfig(
  tree: readonly NginxDirective[],
  path = NGINX_CONF_PATH,
): NginxConfigError | null {
  if (!tree.some((d) => d.name === 'events')) {
    return { message: `nginx: [emerg] no "events" section in configuration in ${path}` };
  }
  return validateProxyPass(tree);
}

/**
 * §P6 — `nginx -t` refuse une URL de mandat qu'il ne sait pas lire, avec
 * le message du vrai. C'est le seul contrôle fait ICI : la RÉSOLUTION de
 * l'hôte n'en est pas un, parce qu'elle dépend de l'état du réseau au
 * moment de la requête et non du fichier. Un vrai nginx échoue au
 * démarrage sur un amont introuvable ; ici l'amont injoignable donne un
 * `502` et la raison dans `error.log`, ce qui est la panne que le TP
 * cherche à montrer.
 */
/**
 * Les paramètres de `listen`, rangés comme ce dépôt range les options
 * de `curl` et d'`openssl` : ceux qui AGISSENT, ceux que nginx connaît
 * et que cette version ne sait pas produire, et le reste — qui n'existe
 * pas et reçoit le message de nginx pour un paramètre invalide.
 */
const LISTEN_APPLIQUES = new Set(['default_server', 'ssl']);

/**
 * Connus de nginx, réglages de socket sans effet observable ici : rien
 * ne modélise une file d'attente d'acceptation ni un tampon noyau. Ils
 * figurent dans des configurations réelles, donc les refuser coûterait
 * plus de vérité qu'il n'en apporterait — la règle déjà retenue pour
 * `worker_processes`.
 */
const LISTEN_INERTES = new Set([
  'bind', 'deferred', 'reuseport', 'so_keepalive',
]);
const LISTEN_INERTES_AVEC_VALEUR = new Set([
  'backlog', 'rcvbuf', 'sndbuf', 'accept_filter', 'setfib', 'fastopen', 'ipv6only',
]);

/**
 * Connus de nginx, avec un effet RÉEL que cette version ne produit pas.
 * Les accepter en silence est le pire des trois cas : un opérateur qui
 * a écrit `http2` croit tenir du HTTP/2, et la machine servait du
 * HTTP/1.1 sans le détromper. `proxy_protocol` est du même ordre — il
 * change le format sur le fil et la provenance de l'adresse du client.
 */
const LISTEN_NON_IMPLEMENTES = new Set(['http2', 'http3', 'quic', 'spdy', 'proxy_protocol']);

function validateListenParams(node: NginxDirective): NginxConfigError | null {
  for (const arg of node.args.slice(1)) {
    const cle = arg.split('=')[0].toLowerCase();
    if (LISTEN_APPLIQUES.has(cle) || LISTEN_INERTES.has(cle)) continue;
    if (arg.includes('=') && LISTEN_INERTES_AVEC_VALEUR.has(cle)) continue;
    if (LISTEN_NON_IMPLEMENTES.has(cle)) {
      return emerg(
        `the "${cle}" parameter of the "listen" directive is not supported by this simulator`,
        node.file, node.line);
    }
    return emerg(`invalid parameter "${arg}"`, node.file, node.line);
  }
  return null;
}

function validateProxyPass(nodes: readonly NginxDirective[]): NginxConfigError | null {
  for (const node of nodes) {
    // §5 — `listen 443 ssl http2;` était accepté, et le serveur servait
    // du HTTP/1.1 : le paramètre était lu par personne. C'est le décor
    // que ce PRD supprime, et son cas le plus trompeur — un opérateur
    // qui a écrit `http2` croit tenir du HTTP/2, et rien dans la
    // machine ne le détrompe. Refusé tant que la couche ne le sert pas.
    if (node.name === 'listen') {
      const mauvais = validateListenParams(node);
      if (mauvais) return mauvais;
    }
    if (node.name === 'proxy_pass') {
      if (node.args.length !== 1) {
        return emerg('invalid number of arguments in "proxy_pass" directive', node.file, node.line);
      }
      if (!parseProxyPass(node.args[0])) {
        return emerg(`invalid URL prefix in "${node.args[0]}"`, node.file, node.line);
      }
    }
    if (node.name === 'upstream' && !node.args[0]) {
      return emerg('invalid number of arguments in "upstream" directive', node.file, node.line);
    }
    if (node.block) {
      const inner = validateProxyPass(node.block);
      if (inner) return inner;
    }
  }
  return null;
}

// ─── Modèle exploité par le serveur ────────────────────────────────────

/** §P6 — un membre d'`upstream`, tel que la ligne `server` l'écrit. */
export interface NginxUpstreamServer {
  readonly host: string;
  readonly port: number;
  readonly down: boolean;
}

export interface NginxUpstream {
  readonly name: string;
  readonly servers: readonly NginxUpstreamServer[];
}

/** §P6 — la cible d'un `proxy_pass`, telle qu'elle est écrite. */
export interface NginxProxyPass {
  /** `http` ou `https` — le second n'est pas servi, et le dit. */
  readonly scheme: string;
  /** Une adresse littérale, un nom d'hôte, ou le nom d'un `upstream`. */
  readonly host: string;
  readonly port: number;
  /**
   * Le chemin écrit après l'autorité, s'il y en a un.
   *
   * La règle de nginx tient à sa PRÉSENCE et non à sa valeur :
   * `proxy_pass http://amont;` transmet l'URI d'origine telle quelle,
   * `proxy_pass http://amont/;` remplace la partie du chemin qui a
   * servi à choisir la `location`. Une chaîne vide et `undefined` ne
   * veulent donc pas dire la même chose.
   */
  readonly path?: string;
}

export interface NginxLocation {
  readonly path: string;
  readonly root?: string;
  readonly index?: readonly string[];
  readonly tryFiles?: readonly string[];
  readonly returnStatus?: number;
  readonly returnTarget?: string;
  readonly autoindex?: boolean;
  readonly addHeaders: readonly (readonly [string, string])[];
  /** §P6 */
  readonly proxyPass?: NginxProxyPass;
  readonly proxySetHeaders: readonly (readonly [string, string])[];
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
  /** §P5 — the PEM files this server presents, as written in the file. */
  readonly sslCertificate: string | null;
  readonly sslCertificateKey: string | null;
  /** §P6 — hérités par les `location` qui n'en déclarent pas. */
  readonly proxySetHeaders: readonly (readonly [string, string])[];
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

/**
 * `proxy_pass http://hote[:port][/chemin]`.
 *
 * Le port par défaut suit le schéma (80 / 443) comme chez nginx, et le
 * chemin est conservé DISTINCT de son absence — voir `NginxProxyPass`.
 */
export function parseProxyPass(raw: string | undefined): NginxProxyPass | null {
  if (!raw) return null;
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(raw);
  if (!m) return null;
  const scheme = m[1];
  const port = m[3] ? Number(m[3]) : (scheme === 'https' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { scheme, host: m[2], port, path: m[4] };
}

function parseUpstreamServer(args: readonly string[]): NginxUpstreamServer | null {
  const first = args[0];
  if (!first) return null;
  const m = /^([^:]+)(?::(\d+))?$/.exec(first);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port, down: args.includes('down') };
}

export function extractUpstreams(tree: readonly NginxDirective[]): NginxUpstream[] {
  const out: NginxUpstream[] = [];
  const walk = (nodes: readonly NginxDirective[]): void => {
    for (const node of nodes) {
      if (node.name === 'upstream') {
        const servers: NginxUpstreamServer[] = [];
        for (const d of node.block ?? []) {
          if (d.name !== 'server') continue;
          const s = parseUpstreamServer(d.args);
          if (s) servers.push(s);
        }
        out.push({ name: node.args[0] ?? '', servers });
      } else if (node.block) walk(node.block);
    }
  };
  walk(tree);
  return out;
}

function collectLocation(node: NginxDirective, inheritedRoot: string): NginxLocation {
  const loc: {
    path: string; root?: string; index?: string[]; tryFiles?: string[];
    returnStatus?: number; returnTarget?: string; autoindex?: boolean;
    addHeaders: (readonly [string, string])[];
    proxyPass?: NginxProxyPass;
    proxySetHeaders: (readonly [string, string])[];
  } = { path: node.args[node.args.length - 1] ?? '/', addHeaders: [], proxySetHeaders: [] };

  for (const d of node.block ?? []) {
    if (d.name === 'root') loc.root = d.args[0];
    else if (d.name === 'index') loc.index = [...d.args];
    else if (d.name === 'try_files') loc.tryFiles = [...d.args];
    else if (d.name === 'autoindex') loc.autoindex = d.args[0] === 'on';
    else if (d.name === 'add_header' && d.args.length >= 2) loc.addHeaders.push([d.args[0], d.args[1]]);
    else if (d.name === 'proxy_pass') loc.proxyPass = parseProxyPass(d.args[0]) ?? undefined;
    else if (d.name === 'proxy_set_header' && d.args.length >= 2) {
      loc.proxySetHeaders.push([d.args[0], d.args.slice(1).join(' ')]);
    } else if (d.name === 'return') {
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
  let sslCertificate: string | null = null;
  let sslCertificateKey: string | null = null;
  const proxySetHeaders: (readonly [string, string])[] = [];

  for (const d of node.block ?? []) {
    if (d.name === 'ssl_certificate') sslCertificate = d.args[0] ?? null;
    else if (d.name === 'ssl_certificate_key') sslCertificateKey = d.args[0] ?? null;
    else if (d.name === 'listen') {
      const spec = parseListen(d.args);
      if (spec && !listen.some((l) => l.port === spec.port)) listen.push(spec);
    } else if (d.name === 'server_name') serverNames = [...d.args];
    else if (d.name === 'root') root = d.args[0] ?? root;
    else if (d.name === 'index') index = [...d.args];
    else if (d.name === 'access_log') accessLog = d.args[0] === 'off' ? null : (d.args[0] ?? accessLog);
    else if (d.name === 'error_log') errorLog = d.args[0] ?? errorLog;
    else if (d.name === 'add_header' && d.args.length >= 2) addHeaders.push([d.args[0], d.args[1]]);
    else if (d.name === 'proxy_set_header' && d.args.length >= 2) {
      proxySetHeaders.push([d.args[0], d.args.slice(1).join(' ')]);
    }
  }
  for (const d of node.block ?? []) {
    if (d.name === 'location') locations.push(collectLocation(d, root));
  }

  return {
    listen, serverNames, root, index, locations, accessLog, errorLog, addHeaders,
    sslCertificate, sslCertificateKey, proxySetHeaders,
  };
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
