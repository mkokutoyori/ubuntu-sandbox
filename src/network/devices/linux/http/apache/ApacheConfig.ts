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

import {
  isApacheSslDirective, checkApacheSslDirective, apacheSslDirectiveSpecs, resolveApacheSsl, sessionCacheProblem,
  parseVerifyClient, type ApacheSslDirective, type ApacheSslSettings, type ApacheVerifyClient,
} from './ApacheSsl';

export type ApacheAuthSection = 'Location' | 'LocationMatch' | 'Directory' | 'DirectoryMatch';

export interface ApacheDirectoryAuth {
  readonly section: ApacheAuthSection;
  readonly pattern: string;
  verifyClient: ApacheVerifyClient | null;
  verifyDepth: number | null;
  readonly line: number;
}

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
  readonly ssl: ApacheSslSettings;
  readonly directoryAuth: readonly ApacheDirectoryAuth[];
  readonly protocolSet: boolean;
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


/**
 * Quelle directive vient de quel module — et pourquoi cette table est la
 * forme JUSTE du contrôle.
 *
 * Apache ne dit pas « directive inconnue » : il dit
 * « *Invalid command 'X', perhaps misspelled **or defined by a module not
 * included in the server configuration*** ». Son propre message reconnaît
 * qu'il ne sait pas distinguer une faute de frappe d'un module éteint,
 * parce que sa grammaire est définie PAR les modules chargés. Un contrôle
 * qui refuserait `ProxyPass` en dur dirait donc quelque chose de faux :
 * ce qui cloche n'est pas la directive, c'est que `mod_proxy` n'est pas
 * allumé — et `a2enmod proxy` est la réponse.
 *
 * `core` désigne ce que le serveur comprend sans module chargeable.
 */
const DIRECTIVE_MODULE: Readonly<Record<string, string>> = {
  serveradmin: 'core', servername: 'core', serveralias: 'core',
  serversignature: 'core', documentroot: 'core', errorlog: 'core',
  loglevel: 'core', options: 'core', allowoverride: 'core',
  errordocument: 'core', limitrequestbody: 'core', timeout: 'core',
  keepalive: 'core', keepalivetimeout: 'core', hostnamelookups: 'core',
  accessfilename: 'core', adddefaultcharset: 'core', usecanonicalname: 'core',
  protocols: 'core', serverpath: 'core', maxkeepaliverequests: 'core',
  customlog: 'log_config', transferlog: 'log_config', logformat: 'log_config',
  require: 'authz_core', directoryindex: 'dir', fallbackresource: 'dir',
  setenv: 'env', unsetenv: 'env', passenv: 'env',
  indexoptions: 'autoindex', indexignore: 'autoindex', headername: 'autoindex',
  alias: 'alias', aliasmatch: 'alias', scriptalias: 'alias',
  redirect: 'alias', redirectmatch: 'alias', redirectpermanent: 'alias',
  header: 'headers', requestheader: 'headers',
  rewriteengine: 'rewrite', rewriterule: 'rewrite', rewritecond: 'rewrite',
  rewritebase: 'rewrite', rewriteoptions: 'rewrite', rewritemap: 'rewrite',
  ...Object.fromEntries(apacheSslDirectiveSpecs().map((spec) => [spec.name.toLowerCase(), 'ssl'])),
  proxypass: 'proxy', proxypassreverse: 'proxy', proxypreservehost: 'proxy',
  proxyrequests: 'proxy', proxytimeout: 'proxy', proxypassmatch: 'proxy',
  proxyvia: 'proxy', proxyaddheaders: 'proxy',
  expiresactive: 'expires', expiresbytype: 'expires', expiresdefault: 'expires',
  authtype: 'auth_basic', authname: 'auth_basic', authbasicprovider: 'auth_basic',
  authuserfile: 'authn_file', authgroupfile: 'authz_groupfile',
  cgimapextension: 'cgi', scriptlog: 'cgi',
  userdir: 'userdir',
  addoutputfilterbytype: 'filter', setoutputfilter: 'filter',
  addtype: 'mime', addencoding: 'mime', addhandler: 'mime', addcharset: 'mime',
};

/**
 * Ce que le serveur de ce simulateur LIT vraiment (le `switch` de
 * `parseApacheConfig`). Toute autre directive n'a, au mieux, aucun effet.
 */
const APACHE_APPLIQUEES = new Set([
  'documentroot', 'servername', 'serveralias', 'directoryindex',
  'customlog', ...apacheSslDirectiveSpecs().map((spec) => spec.name.toLowerCase()),
]);

/**
 * Acceptées sans effet observable : elles décrivent une identité, un
 * journal ou un réglage que rien ici ne mesure. Les refuser rendrait
 * invalide la configuration que Debian LIVRE — le coût dépasserait le
 * gain, comme pour `worker_processes` chez nginx.
 */
const APACHE_INERTES = new Set([
  'serveradmin', 'serversignature', 'errorlog', 'loglevel', 'options',
  'allowoverride', 'require', 'limitrequestbody', 'timeout', 'keepalive',
  'keepalivetimeout', 'hostnamelookups', 'accessfilename', 'adddefaultcharset',
  'usecanonicalname', 'serverpath', 'maxkeepaliverequests',
  'transferlog', 'logformat', 'setenv', 'unsetenv', 'passenv',
  'indexoptions', 'indexignore', 'headername',
  'addtype', 'addencoding', 'addhandler', 'addcharset',
  'addoutputfilterbytype', 'setoutputfilter',
]);

/**
 * Le module est chargé, la directive existe, et ce serveur ne produit pas
 * son effet. C'est le cas où le silence coûte le plus cher : un
 * `ProxyPass` accepté et sans effet fait croire à un mandat qui
 * n'existe pas, et un `RewriteRule` avalé fait chercher la panne
 * ailleurs pendant une heure.
 */
const APACHE_NON_IMPLEMENTEES = new Set([
  'proxypass', 'proxypassreverse', 'proxypreservehost', 'proxyrequests',
  'proxytimeout', 'proxypassmatch', 'proxyvia', 'proxyaddheaders',
  'rewriteengine', 'rewriterule', 'rewritecond', 'rewritebase',
  'rewriteoptions', 'rewritemap',
  'alias', 'aliasmatch', 'scriptalias', 'redirect', 'redirectmatch',
  'redirectpermanent', 'fallbackresource',
  'header', 'requestheader',
  'expiresactive', 'expiresbytype', 'expiresdefault',
  'authtype', 'authname', 'authbasicprovider', 'authuserfile',
  'authgroupfile',
  'protocols', 'userdir', 'cgimapextension', 'scriptlog',
  'errordocument',
]);

/**
 * `Invalid command`, le message d'Apache — le même pour une faute de
 * frappe et pour un module éteint, parce qu'Apache lui-même ne les
 * distingue pas.
 */
function invalidCommand(nom: string, path: string, n: number): ApacheConfigError {
  return {
    message: `apache2: Syntax error on line ${n} of ${path}: Invalid command '${nom}', `
      + 'perhaps misspelled or defined by a module not included in the server configuration',
    line: n,
  };
}

/**
 * Les modules chargés, lus là où `apachectl -M` les lit : le répertoire
 * `mods-enabled`, et le nom pris dans la ligne `LoadModule` du fichier
 * plutôt que dans le nom du lien — c'est `LoadModule` qui nomme le
 * module, et renommer un lien ne change pas ce qu'Apache charge.
 *
 * Une seule lecture pour les deux usages, sans quoi `apachectl -M` et
 * `apachectl configtest` pourraient un jour ne pas être d'accord sur ce
 * qui est chargé — la contradiction la plus déroutante possible.
 */
export function loadedApacheModules(
  src: ApacheFileSource, modsEnabled: string,
): Set<string> {
  const out = new Set<string>();
  for (const nom of src.list(modsEnabled) ?? []) {
    if (!nom.endsWith('.load')) continue;
    const texte = src.read(`${modsEnabled}/${nom}`) ?? '';
    const m = /^\s*LoadModule\s+(\S+)/m.exec(texte);
    out.add((m ? m[1] : nom.replace(/\.load$/, '')).replace(/_module$/, ''));
  }
  // Ce qui est lié dans le binaire est chargé sans `mods-enabled`.
  for (const statique of ['core', 'so', 'watchdog', 'http_core',
    'log_config', 'logio', 'version', 'unixd']) out.add(statique);
  return out;
}

export function validateApacheDirective(
  nom: string, path: string, n: number, modulesCharges: ReadonlySet<string>,
): ApacheConfigError | null {
  const cle = nom.toLowerCase();
  const module = DIRECTIVE_MODULE[cle];
  // Inconnue, ou fournie par un module qui n'est pas chargé : le même
  // message, celui d'Apache.
  if (!module) return invalidCommand(nom, path, n);
  if (module !== 'core' && !modulesCharges.has(module)) return invalidCommand(nom, path, n);
  if (APACHE_APPLIQUEES.has(cle) || APACHE_INERTES.has(cle)) return null;
  if (APACHE_NON_IMPLEMENTEES.has(cle)) {
    return {
      message: `apache2: Syntax error on line ${n} of ${path}: `
        + `the '${nom}' directive is not supported by this simulator`,
      line: n,
    };
  }
  return null;
}

export interface ApacheConfigLayout {
  readonly mainConf: string;
  readonly modsEnabled: string;
  readonly confEnabled: string;
}

interface ScanHandlers {
  openVirtualHost(argument: string, line: number): ApacheConfigError | null;
  closeVirtualHost(): void;
  inVirtualHost(): boolean;
  directive(name: string, rawValue: string, line: number): ApacheConfigError | null;
  sectionDirective(section: OpenSection, name: string, rawValue: string, line: number): ApacheConfigError | null;
}

interface OpenSection {
  readonly kind: string;
  readonly argument: string;
}

const AUTH_SECTIONS: ReadonlySet<string> = new Set(['location', 'locationmatch', 'directory', 'directorymatch']);

const NESTED_SECTION_OPEN = /^<(Directory|DirectoryMatch|Location|LocationMatch|Files|FilesMatch|Proxy|ProxyMatch|If|ElseIf|Else|RequireAll|RequireAny|RequireNone|Limit|LimitExcept|IfDefine|IfVersion)(\s[^>]*)?>$/i;
const NESTED_SECTION_CLOSE = /^<\/(Directory|DirectoryMatch|Location|LocationMatch|Files|FilesMatch|Proxy|ProxyMatch|If|ElseIf|Else|RequireAll|RequireAny|RequireNone|Limit|LimitExcept|IfDefine|IfVersion)>$/i;

function scanConfigText(
  text: string, path: string, modulesCharges: ReadonlySet<string> | undefined, handlers: ScanHandlers,
): ApacheConfigError | null {
  let skipDepth = 0;
  const sections: OpenSection[] = [];
  for (const { n, content } of meaningfulLines(text)) {
    const ifModule = /^<IfModule\s+!?(?:mod_)?([A-Za-z0-9_]+)(?:\.c)?\s*>$/i.exec(content);
    if (ifModule) {
      const negated = content.includes('!');
      const name = ifModule[1].replace(/_module$/, '');
      const loaded = modulesCharges === undefined || modulesCharges.has(name);
      if (negated ? loaded : !loaded) skipDepth++;
      else if (skipDepth > 0) skipDepth++;
      continue;
    }
    if (/^<\/IfModule>$/i.test(content)) {
      if (skipDepth > 0) skipDepth--;
      continue;
    }
    if (skipDepth > 0) continue;

    const opened = NESTED_SECTION_OPEN.exec(content);
    if (opened) {
      sections.push({ kind: opened[1], argument: (opened[2] ?? '').trim().replace(/^"|"$/g, '') });
      continue;
    }
    if (NESTED_SECTION_CLOSE.test(content)) { sections.pop(); continue; }
    if (sections.length > 0) {
      const directive = /^(\w+)(?:\s+(.+))?$/.exec(content);
      const name = directive?.[1];
      if (name && /^ssl/i.test(name) && isApacheSslDirective(name)) {
        const inner = sections[sections.length - 1];
        if (/^sslverify(client|depth)$/i.test(name) && AUTH_SECTIONS.has(inner.kind.toLowerCase())) {
          const error = handlers.sectionDirective(inner, name, directive?.[2] ?? '', n);
          if (error) return error;
          continue;
        }
        return {
          message: `apache2: Syntax error on line ${n} of ${path}: ${name} inside a <${inner.kind}> section needs a TLS renegotiation after the handshake; `
            + 'only SSLVerifyClient and SSLVerifyDepth inside <Location>, <LocationMatch>, <Directory> or <DirectoryMatch> are supported by this simulator',
          line: n,
        };
      }
      continue;
    }

    const opening = /^<VirtualHost\s+(.+)>$/i.exec(content);
    if (opening) {
      const error = handlers.openVirtualHost(opening[1], n);
      if (error) return error;
      continue;
    }
    if (/^<\/VirtualHost>$/i.test(content)) {
      handlers.closeVirtualHost();
      continue;
    }
    const match = /^(\w+)(?:\s+(.+))?$/.exec(content);
    if (!match) continue;
    const error = handlers.directive(match[1], match[2] ?? '', n);
    if (error) return error;
  }
  return null;
}

function splitArguments(raw: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of raw.matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function sslDirectiveProblem(
  directive: ApacheSslDirective, inVirtualHost: boolean, src: ApacheFileSource,
  modulesCharges: ReadonlySet<string> | undefined,
): string | null {
  const arity = checkApacheSslDirective(directive);
  if (arity) return arity;
  const spec = apacheSslDirectiveSpecs().find((candidate) => candidate.name.toLowerCase() === directive.name.toLowerCase());
  if (spec?.scope === 'global' && inVirtualHost) return `${spec.name} cannot occur within <VirtualHost> section`;
  const name = directive.name.toLowerCase();
  const first = directive.args[0] ?? '';
  if (name === 'sslstaplingcache' && modulesCharges) {
    const cache = sessionCacheProblem(first, modulesCharges);
    if (cache) return cache.replace('SSLSessionCache: ', 'SSLStaplingCache: ').replace(' session cache not supported', ' stapling cache not supported').replace('). Maybe', ') Maybe');
  }
  if (name === 'sslsessioncache' && modulesCharges) {
    const cache = sessionCacheProblem(first, modulesCharges);
    if (cache) return cache;
  }
  const FILE_DIRECTIVES = new Set([
    'sslcertificatefile', 'sslcertificatekeyfile', 'sslcertificatechainfile', 'sslcacertificatefile',
    'sslcarevocationfile', 'sslcadnrequestfile', 'sslsessionticketkeyfile', 'sslocsprespondercertificatefile',
  ]);
  const DIRECTORY_DIRECTIVES = new Set(['sslcacertificatepath', 'sslcarevocationpath', 'sslcadnrequestpath']);
  if (FILE_DIRECTIVES.has(name)) {
    const content = src.read(first);
    if (content === null || content === '') return `${directive.name}: file '${first}' does not exist or is empty`;
  } else if (DIRECTORY_DIRECTIVES.has(name) && src.list(first) === null) {
    return `${directive.name}: directory '${first}' does not exist`;
  }
  return null;
}

export function parseApacheConfig(
  src: ApacheFileSource,
  portsPath: string,
  sitesEnabled: string,
  envvarsPath = '/etc/apache2/envvars',
  /**
   * Les modules chargés. Absent = on ne juge pas — les appelants qui ne
   * les connaissent pas gardent le comportement d'avant, plutôt que de
   * refuser tout ce qui n'est pas `core`.
   */
  modulesCharges?: ReadonlySet<string>,
  layout?: ApacheConfigLayout,
): { config: ApacheConfig; error: ApacheConfigError | null } {
  const env = readEnvvars(src, envvarsPath);
  const listenPorts: number[] = [];
  const vhosts: ApacheVirtualHost[] = [];
  const globalSsl: ApacheSslDirective[] = [];
  const globalAuth: ApacheDirectoryAuth[] = [];

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

  const globalFiles: string[] = [];
  if (layout) {
    for (const name of (src.list(layout.modsEnabled) ?? []).filter((n) => n.endsWith('.conf')).sort()) {
      globalFiles.push(`${layout.modsEnabled}/${name}`);
    }
    globalFiles.push(layout.mainConf);
    for (const name of (src.list(layout.confEnabled) ?? []).filter((n) => n.endsWith('.conf')).sort()) {
      globalFiles.push(`${layout.confEnabled}/${name}`);
    }
  }

  const failure = (error: ApacheConfigError): { config: ApacheConfig; error: ApacheConfigError } => ({
    config: { listenPorts, vhosts }, error,
  });

  const recordSsl = (
    target: ApacheSslDirective[], inVirtualHost: boolean, path: string, name: string, rawValue: string, n: number,
  ): ApacheConfigError | null => {
    if (!isApacheSslDirective(name)) return null;
    const directive: ApacheSslDirective = {
      name, args: splitArguments(expand(rawValue, env)), file: path, line: n,
    };
    const problem = sslDirectiveProblem(directive, inVirtualHost, src, modulesCharges);
    if (problem) return { message: `AH00526: Syntax error on line ${n} of ${path}:\n${problem}`, line: n };
    target.push(directive);
    return null;
  };

  const recordSectionAuth = (
    list: ApacheDirectoryAuth[], index: Map<OpenSection, ApacheDirectoryAuth>, path: string,
    section: OpenSection, name: string, rawValue: string, n: number,
  ): ApacheConfigError | null => {
    const args = splitArguments(expand(rawValue, env));
    const value = args[0] ?? '';
    let entry = index.get(section);
    if (entry === undefined) {
      entry = { section: section.kind as ApacheAuthSection, pattern: section.argument, verifyClient: null, verifyDepth: null, line: n };
      index.set(section, entry);
      list.push(entry);
    }
    if (name.toLowerCase() === 'sslverifyclient') {
      const parsed = parseVerifyClient(name, value);
      if (parsed.error !== null) return { message: `AH00526: Syntax error on line ${n} of ${path}:\n${parsed.error}`, line: n };
      entry.verifyClient = parsed.mode;
    } else {
      const depth = Number.parseInt(value, 10);
      if (!Number.isInteger(depth) || depth < 0) {
        return { message: `AH00526: Syntax error on line ${n} of ${path}:\n${name}: Invalid argument '${value}'`, line: n };
      }
      entry.verifyDepth = depth;
    }
    return null;
  };
  const globalSectionIndex = new Map<OpenSection, ApacheDirectoryAuth>();

  for (const path of globalFiles) {
    const text = src.read(path);
    if (text === null) continue;
    const error = scanConfigText(text, path, modulesCharges, {
      openVirtualHost: () => null,
      closeVirtualHost: () => undefined,
      inVirtualHost: () => false,
      directive: (name, rawValue, n) => {
        if (!isApacheSslDirective(name)) return null;
        if (modulesCharges) {
          const bad = validateApacheDirective(name, path, n, modulesCharges);
          if (bad) return bad;
        }
        return recordSsl(globalSsl, false, path, name, rawValue, n);
      },
      sectionDirective: (section, name, rawValue, n) => recordSectionAuth(globalAuth, globalSectionIndex, path, section, name, rawValue, n),
    });
    if (error) return failure(error);
  }

  const files = (src.list(sitesEnabled) ?? []).sort();
  for (const name of files) {
    const path = `${sitesEnabled}/${name}`;
    const text = src.read(path);
    if (text === null) continue;

    let current: {
      port: number; serverName: string | null; aliases: string[];
      root: string; index: string[]; accessLog: string | null;
      ssl: ApacheSslDirective[];
      auth: ApacheDirectoryAuth[];
    } | null = null;
    const sectionIndex = new Map<OpenSection, ApacheDirectoryAuth>();
    let sslError: ApacheConfigError | null = null;

    const error = scanConfigText(text, path, modulesCharges, {
      openVirtualHost: (argument, n) => {
        const port = virtualHostPort(argument);
        if (port === null) {
          return { message: `Syntax error on line ${n} of ${path}: bad VirtualHost address`, line: n };
        }
        current = {
          port, serverName: null, aliases: [],
          root: '/var/www/html', index: [...DEFAULT_INDEX], accessLog: null, ssl: [], auth: [],
        };
        return null;
      },
      closeVirtualHost: () => {
        if (current) {
          const resolved = resolveApacheSsl(globalSsl, current.ssl);
          if (resolved.ok === false) {
            sslError = {
              message: `AH00526: Syntax error on line ${resolved.directive.line} of ${resolved.directive.file}:\n${resolved.error}`,
              line: resolved.directive.line,
            };
          } else {
            vhosts.push({
              port: current.port,
              serverName: current.serverName,
              serverAliases: current.aliases,
              documentRoot: current.root,
              directoryIndex: current.index,
              accessLog: current.accessLog,
              ssl: resolved.settings,
              directoryAuth: [...globalAuth, ...current.auth],
              protocolSet: current.ssl.some((d) => d.name.toLowerCase() === 'sslprotocol'),
              source: path,
            });
          }
        }
        current = null;
      },
      inVirtualHost: () => current !== null,
      sectionDirective: (section, name, rawValue, n) => (current
        ? recordSectionAuth(current.auth, sectionIndex, path, section, name, rawValue, n)
        : recordSectionAuth(globalAuth, globalSectionIndex, path, section, name, rawValue, n)),
      directive: (directive, rawArgs, n) => {
        if (modulesCharges) {
          const bad = validateApacheDirective(directive, path, n, modulesCharges);
          if (bad) return bad;
        }
        if (isApacheSslDirective(directive)) {
          return recordSsl(current ? current.ssl : globalSsl, current !== null, path, directive, rawArgs, n);
        }
        if (!current) return null;
        // Values go through `envvars`: Debian's shipped configuration writes
        // `${APACHE_LOG_DIR}/access.log`, and without this expansion the log
        // would land in a directory literally named `${APACHE_LOG_DIR}`.
        const value = expand(rawArgs.replace(/^"|"$/g, '').trim(), env);
        switch (directive.toLowerCase()) {
          case 'documentroot': current.root = value.replace(/\/$/, ''); break;
          case 'servername': current.serverName = value.toLowerCase(); break;
          case 'serveralias': current.aliases.push(...value.toLowerCase().split(/\s+/)); break;
          case 'directoryindex': current.index = value.split(/\s+/); break;
          case 'customlog': current.accessLog = value.split(/\s+/)[0]; break;
          default: break;
        }
        return null;
      },
    });
    if (error) return failure(error);
    if (sslError) return failure(sslError);
    if (current) {
      return failure({ message: `Syntax error in ${path}: expected </VirtualHost> before end of file` });
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

export function apacheNameMatches(pattern: string, name: string): boolean {
  const source = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(name.toLowerCase());
}

/** The vhost that answers: `ServerName`/`ServerAlias` first, else the first one. */
export function selectVirtualHost(
  config: ApacheConfig, port: number, hostHeader: string, candidates?: readonly ApacheVirtualHost[],
): ApacheVirtualHost | null {
  const onThisPort = candidates ?? config.vhosts.filter((v) => v.port === port);
  if (onThisPort.length === 0) return null;
  const name = hostHeader.split(':')[0].toLowerCase();
  const exact = onThisPort.find(
    (v) => (v.serverName !== null && apacheNameMatches(v.serverName, name))
      || v.serverAliases.some((alias) => apacheNameMatches(alias, name)),
  );
  // Apache keeps the FIRST vhost of a port as the default host — the
  // alphabetical order of the files in `sites-enabled`, which is why a real
  // machine uses numeric prefixes (`000-default`).
  return exact ?? onThisPort[0];
}

function sectionMatches(entry: ApacheDirectoryAuth, vhost: ApacheVirtualHost, urlPath: string): boolean {
  const regex = (pattern: string, subject: string): boolean => {
    try { return new RegExp(pattern.replace(/^~\*?\s*/, ''), pattern.startsWith('~*') ? 'i' : '').test(subject); } catch { return false; }
  };
  const prefix = (base: string, subject: string): boolean => {
    const trimmed = base.length > 1 ? base.replace(/\/+$/, '') : '';
    return trimmed === '' || subject === trimmed || subject.startsWith(`${trimmed}/`);
  };
  const root = vhost.documentRoot.replace(/\/+$/, '');
  switch (entry.section) {
    case 'Location': return entry.pattern.startsWith('~') ? regex(entry.pattern, urlPath) : prefix(entry.pattern, urlPath);
    case 'LocationMatch': return regex(entry.pattern, urlPath);
    case 'Directory': {
      if (entry.pattern.startsWith('~')) return regex(entry.pattern, `${root}${urlPath}`);
      if (entry.pattern === root || entry.pattern === `${root}/`) return true;
      return entry.pattern.startsWith(`${root}/`) && prefix(entry.pattern.slice(root.length), urlPath);
    }
    case 'DirectoryMatch': return regex(entry.pattern, `${root}${urlPath}`);
  }
}

export function effectiveClientVerify(vhost: ApacheVirtualHost, target: string): ApacheVerifyClient | null {
  const urlPath = target.split('?')[0].split('#')[0] || '/';
  let mode: ApacheVerifyClient | null = null;
  for (const entry of vhost.directoryAuth) {
    if (entry.verifyClient !== null && sectionMatches(entry, vhost, urlPath)) mode = entry.verifyClient;
  }
  return mode;
}
