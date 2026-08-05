/**
 * docs/PRD-Manquements.md §M4a — reading apache2's configuration.
 *
 * Enough for the files to DECIDE: the `Listen` directives of `ports.conf`,
 * and the `<VirtualHost>` blocks of `sites-enabled/`, with their
 * `DocumentRoot`, `ServerName` and aliases. The rest of Apache's grammar
 * (modules, `<Directory>`, `.htaccess`, rewriting) is read and ignored
 * rather than refused, because a real `apache2.conf` is full of it and
 * failing on it would make the server unusable.
 *
 * The difference with nginx is deliberate and comes from Apache itself:
 * here a port is declared in ONE file (`ports.conf`) and the virtual hosts
 * in OTHERS. A `<VirtualHost *:8080>` with no `Listen 8080` serves
 * nothing — the most common mistake in Apache labs, and it has to happen
 * here too.
 */

export interface ApacheFileSource {
  read(path: string): string | null;
  list(dir: string): string[] | null;
}

export interface ApacheVirtualHost {
  /** The port from `<VirtualHost *:80>`. */
  readonly port: number;
  readonly serverName: string | null;
  readonly serverAliases: readonly string[];
  readonly documentRoot: string;
  readonly directoryIndex: readonly string[];
  readonly accessLog: string | null;
  /** §P5's Apache twin — `SSLEngine on` plus the two PEM files. */
  readonly sslEngine: boolean;
  readonly sslCertificateFile: string | null;
  readonly sslCertificateKeyFile: string | null;
  /** The file it came from, for error messages. */
  readonly source: string;
}

export interface ApacheConfigError {
  readonly message: string;
  readonly line?: number;
}

export interface ApacheConfig {
  readonly listenPorts: readonly number[];
  readonly vhosts: readonly ApacheVirtualHost[];
}

const DEFAULT_INDEX = ['index.html', 'index.htm'];

function meaningfulLines(text: string): Array<{ n: number; content: string }> {
  const out: Array<{ n: number; content: string }> = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/#.*$/, '').trim();
    if (l !== '') out.push({ n: i + 1, content: l });
  });
  return out;
}

/** `Listen 80`, `Listen 0.0.0.0:8080`, `Listen 443 https`. */
function listenPort(argument: string): number | null {
  const first = argument.split(/\s+/)[0];
  const afterColon = first.includes(':') ? first.split(':').pop()! : first;
  const n = Number(afterColon);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** `<VirtualHost *:80>` → 80; `<VirtualHost 10.0.0.1:8080>` → 8080. */
function virtualHostPort(argument: string): number | null {
  const target = argument.replace(/>$/, '').trim().split(/\s+/)[0];
  return listenPort(target.includes(':') ? target.split(':').pop()! : '80');
}

/**
 * `envvars`, read where Apache reads it: the values come from the FILE,
 * not from a table written here, otherwise `APACHE_LOG_DIR=/var/log/web`
 * would have no effect although that is exactly what one changes on a real
 * machine. `$SUFFIX` is empty on an ordinary install (it only serves
 * multiple instances), and a variable `envvars` does not define is left
 * alone — which is what a shell does.
 */
function readEnvvars(src: ApacheFileSource, envvarsPath: string): Map<string, string> {
  const env = new Map<string, string>([['SUFFIX', '']]);
  const text = src.read(envvarsPath);
  if (text === null) return env;
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.replace(/#.*$/, ''));
    if (!m) continue;
    env.set(m[1], expand(m[2].trim().replace(/^"|"$/g, ''), env));
  }
  return env;
}

function expand(value: string, env: Map<string, string>): string {
  return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => {
    const v = env.get(name);
    return v === undefined ? whole : v;
  });
}

export function parseApacheConfig(
  src: ApacheFileSource,
  portsPath: string,
  sitesEnabled: string,
  envvarsPath = '/etc/apache2/envvars',
): { config: ApacheConfig; error: ApacheConfigError | null } {
  const env = readEnvvars(src, envvarsPath);
  const listenPorts: number[] = [];
  const vhosts: ApacheVirtualHost[] = [];

  const ports = src.read(portsPath);
  if (ports === null) {
    return {
      config: { listenPorts, vhosts },
      error: { message: `apache2: could not open configuration file ${portsPath}: No such file or directory` },
    };
  }
  for (const { content } of meaningfulLines(ports)) {
    const m = /^Listen\s+(.+)$/i.exec(content);
    if (!m) continue;
    const p = listenPort(m[1]);
    if (p !== null && !listenPorts.includes(p)) listenPorts.push(p);
  }

  const files = (src.list(sitesEnabled) ?? []).sort();
  for (const name of files) {
    const path = `${sitesEnabled}/${name}`;
    const text = src.read(path);
    if (text === null) continue;

    let current: {
      port: number; serverName: string | null; aliases: string[];
      root: string; index: string[]; accessLog: string | null;
      sslEngine: boolean; sslCert: string | null; sslKey: string | null;
    } | null = null;

    for (const { n, content } of meaningfulLines(text)) {
      const opening = /^<VirtualHost\s+(.+)>$/i.exec(content);
      if (opening) {
        const port = virtualHostPort(opening[1]);
        if (port === null) {
          return {
            config: { listenPorts, vhosts },
            error: { message: `Syntax error on line ${n} of ${path}: bad VirtualHost address`, line: n },
          };
        }
        current = {
          port, serverName: null, aliases: [],
          root: '/var/www/html', index: [...DEFAULT_INDEX], accessLog: null,
          sslEngine: false, sslCert: null, sslKey: null,
        };
        continue;
      }
      if (/^<\/VirtualHost>$/i.test(content)) {
        if (current) {
          vhosts.push({
            port: current.port,
            serverName: current.serverName,
            serverAliases: current.aliases,
            documentRoot: current.root,
            directoryIndex: current.index,
            accessLog: current.accessLog,
            sslEngine: current.sslEngine,
            sslCertificateFile: current.sslCert,
            sslCertificateKeyFile: current.sslKey,
            source: path,
          });
        }
        current = null;
        continue;
      }
      if (!current) continue;

      const directiveMatch = /^(\w+)\s+(.+)$/.exec(content);
      if (!directiveMatch) continue;
      const [, directive, rawValue] = directiveMatch;
      // Values go through `envvars`: Debian's shipped configuration writes
      // `${APACHE_LOG_DIR}/access.log`, and without this expansion the log
      // would land in a directory literally named `${APACHE_LOG_DIR}`.
      const value = expand(rawValue.replace(/^"|"$/g, '').trim(), env);
      switch (directive.toLowerCase()) {
        case 'documentroot': current.root = value.replace(/\/$/, ''); break;
        case 'servername': current.serverName = value.toLowerCase(); break;
        case 'serveralias': current.aliases.push(...value.toLowerCase().split(/\s+/)); break;
        case 'directoryindex': current.index = value.split(/\s+/); break;
        case 'customlog': current.accessLog = value.split(/\s+/)[0]; break;
        case 'sslengine': current.sslEngine = /^on$/i.test(value); break;
        case 'sslcertificatefile': current.sslCert = value; break;
        case 'sslcertificatekeyfile': current.sslKey = value; break;
        default: break; // the rest of the grammar is read and ignored
      }
    }

    if (current) {
      return {
        config: { listenPorts, vhosts },
        error: { message: `Syntax error in ${path}: expected </VirtualHost> before end of file` },
      };
    }
  }

  return { config: { listenPorts, vhosts }, error: null };
}

/**
 * What `apachectl configtest` adds to its `Syntax OK`.
 *
 * A `<VirtualHost *:8080>` that no `Listen 8080` opens is the most
 * frequent mistake in Apache labs. THE REAL APACHE SAYS NOTHING ABOUT IT:
 * it starts, serves nothing on that port, and lets you hunt. So this
 * message is NOT an Apache message and does not pretend to be one — it is
 * a simulator note, prefixed `NOTE:` so it cannot be mistaken for the
 * tool's own output, written because a learner facing Apache's silence has
 * no way to find it. It does not block start-up, exactly like the silence
 * it replaces.
 */
export function apacheWarnings(config: ApacheConfig): string[] {
  const out: string[] = [];
  for (const v of config.vhosts) {
    if (!config.listenPorts.includes(v.port)) {
      out.push(`NOTE: VirtualHost on port ${v.port} (${v.source}) has no matching `
        + 'Listen directive in ports.conf — it will never be reached');
    }
  }
  return out;
}

/** The vhost that answers: `ServerName`/`ServerAlias` first, else the first one. */
export function selectVirtualHost(
  config: ApacheConfig, port: number, hostHeader: string,
): ApacheVirtualHost | null {
  const onThisPort = config.vhosts.filter((v) => v.port === port);
  if (onThisPort.length === 0) return null;
  const name = hostHeader.split(':')[0].toLowerCase();
  const exact = onThisPort.find(
    (v) => v.serverName === name || v.serverAliases.includes(name),
  );
  // Apache keeps the FIRST vhost of a port as the default host — the
  // alphabetical order of the files in `sites-enabled`, which is why a real
  // machine uses numeric prefixes (`000-default`).
  return exact ?? onThisPort[0];
}
