export interface CurlResolveEntry {
  readonly host: string;
  readonly port: number;
  readonly address: string;
}

export interface CurlOptions {
  head: boolean;
  include: boolean;
  insecure: boolean;
  silent: boolean;
  showError: boolean;
  verbose: boolean;
  fail: boolean;
  location: boolean;
  remoteName: boolean;
  output: string | null;
  writeOut: string | null;
  method: string | null;
  data: string[];
  headers: string[];
  user: string | null;
  userAgent: string;
  maxRedirs: number;
  resolve: CurlResolveEntry[];
  caCert: string | null;
  /** `-b` : un fichier de témoins à lire, ou une chaîne `nom=valeur`. */
  cookie: string | null;
  /** `-c` : où écrire le bocal en sortie. */
  cookieJar: string | null;
  /** `-V`/`--version` : n'effectue aucun transfert, imprime et sort. */
  version: boolean;
  /** `-e` : l'en-tête `Referer`. */
  referer: string | null;
  /** `-D` : où écrire les en-têtes de réponse. */
  dumpHeader: string | null;
  /** `-T` : le fichier à téléverser, qui fait de la requête un `PUT`. */
  uploadFile: string | null;
  urls: string[];
}

export type CurlParseResult =
  | { ok: true; options: CurlOptions }
  | { ok: false; message: string; exitCode: number };

export const CURL_USER_AGENT = 'curl/8.5.0';

const TRY_HELP = "curl: try 'curl --help' for more information";

const SHORT_NO_ARG = 'IksSvfLOiV';

const SHORT_WITH_ARG = 'owXdHuAbceDT';

const LONG_NO_ARG: Record<string, string> = {
  head: 'I',
  insecure: 'k',
  silent: 's',
  'show-error': 'S',
  verbose: 'v',
  fail: 'f',
  location: 'L',
  'remote-name': 'O',
  include: 'i',
  version: 'V',
};

const LONG_WITH_ARG: Record<string, string> = {
  output: 'o',
  'write-out': 'w',
  request: 'X',
  data: 'd',
  'data-raw': 'd',
  'data-binary': 'd',
  'data-ascii': 'd',
  header: 'H',
  user: 'u',
  'user-agent': 'A',
  resolve: 'resolve',
  'max-redirs': 'max-redirs',
  cacert: 'cacert',
  cookie: 'b',
  'cookie-jar': 'c',
  referer: 'e',
  'dump-header': 'D',
  'upload-file': 'T',
  'data-urlencode': 'data-urlencode',
};

const UNSUPPORTED_SHORT: Record<string, true> = {
  // `b` et `c` ont quitté cette liste : ils ouvrent la porte du bocal
  // à témoins (`http/cookies/`), un moteur RFC 6265 complet qui
  // n'avait aucun appelant.
  x: true, F: true, C: true, m: true, '#': true,
  E: true, y: true, Y: true, z: true, R: true, j: true, N: true, g: true,
  K: true, r: true, P: true, Q: true, p: true, U: true,
};

const UNSUPPORTED_LONG: Record<string, true> = {
  proxy: true, retry: true, 'retry-delay': true,
  'retry-max-time': true, form: true, 'form-string': true,
  http2: true, 'http2-prior-knowledge': true, http3: true, 'http0.9': true,
  'limit-rate': true, 'continue-at': true, 'progress-bar': true, cert: true,
  // `--version` a quitté la liste des INCONNUES : curl la connaît, et
  // répondre « is unknown » à l'option la plus tapée de toutes était le
  // seul message de ce fichier qui mentait.
  key: true, capath: true, interface: true, 'max-time': true,
  'connect-timeout': true, compressed: true, 'anyauth': true, ntlm: true,
  negotiate: true, digest: true, 'proxy-user': true, socks5: true, socks4: true,
  'tlsv1.2': true, 'tlsv1.3': true, 'ciphers': true, 'keepalive-time': true,
  'speed-limit': true, 'speed-time': true, range: true, 'time-cond': true,
  'remote-time': true, netrc: true, 'trace': true, 'trace-ascii': true,
  config: true,
  'proxytunnel': true, 'ftp-port': true, quote: true, 'no-buffer': true,
};

function defaults(): CurlOptions {
  return {
    head: false,
    include: false,
    insecure: false,
    silent: false,
    showError: false,
    verbose: false,
    fail: false,
    location: false,
    remoteName: false,
    output: null,
    writeOut: null,
    method: null,
    data: [],
    headers: [],
    user: null,
    userAgent: CURL_USER_AGENT,
    maxRedirs: 50,
    resolve: [],
    caCert: null,
    cookie: null,
    cookieJar: null,
    version: false,
    referer: null,
    dumpHeader: null,
    uploadFile: null,
    urls: [],
  };
}

function usageFailure(first: string | null, exitCode = 2): CurlParseResult {
  return { ok: false, message: first ? `${first}\n${TRY_HELP}` : TRY_HELP, exitCode };
}

function unknownShort(letter: string): CurlParseResult {
  return usageFailure(`curl: option -${letter}: is unknown`);
}

function unknownLong(name: string): CurlParseResult {
  return usageFailure(`curl: option --${name}: is unknown`);
}

function unsupported(spelling: string): CurlParseResult {
  return usageFailure(`curl: option ${spelling}: is not implemented in this simulator`);
}

function missingParam(spelling: string): CurlParseResult {
  return usageFailure(`curl: option ${spelling}: requires parameter`);
}

function parseResolveEntry(raw: string): CurlResolveEntry | null {
  const cleaned = raw.startsWith('+') ? raw.slice(1) : raw;
  const parts = cleaned.split(':');
  if (parts.length < 3) return null;
  const host = parts[0];
  const port = Number(parts[1]);
  const address = parts.slice(2).join(':');
  if (!host || !Number.isInteger(port) || port <= 0 || !address) return null;
  return { host, port, address };
}

function applyValued(
  opts: CurlOptions,
  key: string,
  value: string,
  spelling: string,
): CurlParseResult | null {
  switch (key) {
    case 'o': opts.output = value; break;
    case 'w': opts.writeOut = value; break;
    case 'X': opts.method = value.toUpperCase(); break;
    case 'd': opts.data.push(value); break;
    case 'H': opts.headers.push(value); break;
    case 'u': opts.user = value; break;
    case 'b': opts.cookie = value; break;
    case 'c': opts.cookieJar = value; break;
    case 'e': opts.referer = value; break;
    case 'D': opts.dumpHeader = value; break;
    case 'T': opts.uploadFile = value; break;
    case 'data-urlencode': {
      // `nom=valeur` n'encode QUE la valeur ; une chaîne sans `=` est
      // encodée en entier. C'est la règle de curl, et la confondre
      // enverrait `nom%3Dvaleur`, que rien ne sait relire.
      const eq = value.indexOf('=');
      opts.data.push(eq > 0
        ? `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`
        : encodeURIComponent(value));
      break;
    }
    case 'A': opts.userAgent = value; break;
    case 'resolve': {
      const entry = parseResolveEntry(value);
      if (!entry) {
        return { ok: false, message: `curl: (3) Couldn't parse CURLOPT_RESOLVE entry '${value}'`, exitCode: 3 };
      }
      opts.resolve.push(entry);
      break;
    }
    case 'cacert': opts.caCert = value; break;
    case 'max-redirs': {
      const n = Number(value);
      if (!Number.isFinite(n)) return missingParam(spelling);
      opts.maxRedirs = n < 0 ? Number.POSITIVE_INFINITY : n;
      break;
    }
    default: return unknownLong(key);
  }
  return null;
}

function applyFlag(opts: CurlOptions, letter: string): void {
  switch (letter) {
    case 'I': opts.head = true; break;
    case 'i': opts.include = true; break;
    case 'V': opts.version = true; break;
    case 'k': opts.insecure = true; break;
    case 's': opts.silent = true; break;
    case 'S': opts.showError = true; break;
    case 'v': opts.verbose = true; break;
    case 'f': opts.fail = true; break;
    case 'L': opts.location = true; break;
    case 'O': opts.remoteName = true; break;
  }
}

export function parseCurlArgs(args: readonly string[]): CurlParseResult {
  const opts = defaults();
  let onlyOperands = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (onlyOperands || arg === '-' || !arg.startsWith('-')) {
      opts.urls.push(arg);
      continue;
    }
    if (arg === '--') { onlyOperands = true; continue; }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? null : arg.slice(eq + 1);

      if (UNSUPPORTED_LONG[name]) return unsupported(`--${name}`);
      if (LONG_NO_ARG[name] !== undefined) {
        applyFlag(opts, LONG_NO_ARG[name]);
        continue;
      }
      const valued = LONG_WITH_ARG[name];
      if (valued === undefined) return unknownLong(name);
      const value = inline !== null ? inline : args[++i];
      if (value === undefined) return missingParam(`--${name}`);
      const failure = applyValued(opts, valued, value, `--${name}`);
      if (failure) return failure;
      continue;
    }

    const cluster = arg.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      const letter = cluster[c];
      if (UNSUPPORTED_SHORT[letter]) return unsupported(`-${letter}`);
      if (SHORT_NO_ARG.includes(letter)) { applyFlag(opts, letter); continue; }
      if (SHORT_WITH_ARG.includes(letter)) {
        const rest = cluster.slice(c + 1);
        const value = rest.length > 0 ? rest : args[++i];
        if (value === undefined) return missingParam(`-${letter}`);
        const failure = applyValued(opts, letter, value, `-${letter}`);
        if (failure) return failure;
        c = cluster.length;
        continue;
      }
      return unknownShort(letter);
    }
  }

  // `--version` n'effectue aucun transfert : elle n'exige donc pas
  // d'URL, et l'exiger ferait répondre le mode d'emploi à la commande la
  // plus tapée de toutes.
  if (opts.version) return { ok: true, options: opts };
  if (opts.urls.length === 0) return usageFailure(null);
  return { ok: true, options: opts };
}

export function remoteNameFor(path: string): string | null {
  const withoutQuery = path.split(/[?#]/)[0];
  const last = withoutQuery.split('/').pop() ?? '';
  return last.length > 0 ? last : null;
}
