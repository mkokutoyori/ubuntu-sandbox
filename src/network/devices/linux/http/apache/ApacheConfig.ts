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
  sslengine: 'ssl', sslcertificatefile: 'ssl', sslcertificatekeyfile: 'ssl',
  sslcertificatechainfile: 'ssl', sslcacertificatefile: 'ssl',
  sslprotocol: 'ssl', sslciphersuite: 'ssl', sslhonorcipherorder: 'ssl',
  sslverifyclient: 'ssl', sslsessioncache: 'ssl',
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
  'customlog', 'sslengine', 'sslcertificatefile', 'sslcertificatekeyfile',
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
  'sslcertificatechainfile', 'sslcacertificatefile',
  'sslprotocol', 'sslciphersuite', 'sslhonorcipherorder',
  'sslverifyclient', 'sslsessioncache',
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

    // `<IfModule mod_ssl.c>` : Apache SAUTE le bloc quand le module
    // n'est pas chargé. C'est ainsi que Debian livre `default-ssl.conf`,
    // et c'est ce qui fait qu'`a2ensite default-ssl` sans
    // `a2enmod ssl` ne sert RIEN sur 443 au lieu d'échouer — la vraie
    // première marche de tout TP TLS Apache. Le bloc était ignoré comme
    // une ligne quelconque, donc l'hôte virtuel était lu quand même.
    let sauteJusquA = 0;

    for (const { n, content } of meaningfulLines(text)) {
      const ifModule = /^<IfModule\s+!?(?:mod_)?([A-Za-z0-9_]+)(?:\.c)?\s*>$/i.exec(content);
      if (ifModule) {
        const nie = content.includes('!');
        const nom = ifModule[1].replace(/_module$/, '');
        const charge = modulesCharges === undefined || modulesCharges.has(nom);
        if (nie ? charge : !charge) sauteJusquA++;
        else if (sauteJusquA > 0) sauteJusquA++;
        continue;
      }
      if (/^<\/IfModule>$/i.test(content)) {
        if (sauteJusquA > 0) sauteJusquA--;
        continue;
      }
      if (sauteJusquA > 0) continue;

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

      const directiveMatch = /^(\w+)(?:\s+(.+))?$/.exec(content);
      if (!directiveMatch) continue;
      const [, directive, rawArgs] = directiveMatch;
      if (modulesCharges) {
        const mauvaise = validateApacheDirective(directive, path, n, modulesCharges);
        if (mauvaise) return { config: { listenPorts, vhosts }, error: mauvaise };
      }
      const rawValue = rawArgs ?? '';
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
