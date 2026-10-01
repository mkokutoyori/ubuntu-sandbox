export interface ApacheSslDirective {
  readonly name: string;
  readonly args: readonly string[];
  readonly file: string;
  readonly line: number;
}

type Arity = 'take1' | 'take2' | 'take12' | 'take23' | 'flag' | 'raw';

interface ApacheSslSpec {
  readonly name: string;
  readonly arity: Arity;
  readonly scope: 'global' | 'server';
  readonly description: string;
}

const PROTOCOLS_DESCRIPTION = "Enable or disable various SSL protocols ('[+-][SSLv3|TLSv1|TLSv1.1|TLSv1.2] ...' - see manual)";

const SPECS: readonly ApacheSslSpec[] = [
  { name: 'SSLPassPhraseDialog', arity: 'take1', scope: 'global', description: "SSL dialog mechanism for the pass phrase query ('builtin', '|/path/to/pipe_program', or 'exec:/path/to/cgi_program')" },
  { name: 'SSLSessionCache', arity: 'take1', scope: 'global', description: "SSL Session Cache storage ('none', 'nonenotnull', 'dbm:/path/to/file')" },
  { name: 'SSLRandomSeed', arity: 'take23', scope: 'global', description: "SSL Pseudo Random Number Generator (PRNG) seeding source ('startup|connect builtin|file:/path|exec:/path [bytes]')" },
  { name: 'SSLEngine', arity: 'take1', scope: 'server', description: "SSL switch for the protocol engine ('on', 'off')" },
  { name: 'SSLFIPS', arity: 'flag', scope: 'server', description: "Enable FIPS-140 mode (`on', `off')" },
  { name: 'SSLCipherSuite', arity: 'take12', scope: 'server', description: "Colon-delimited list of permitted SSL Ciphers, optional preceded by protocol identifier ('XXX:...:XXX' - see manual)" },
  { name: 'SSLCertificateFile', arity: 'take1', scope: 'server', description: "SSL Server Certificate file ('/path/to/file' - PEM or DER encoded)" },
  { name: 'SSLCertificateKeyFile', arity: 'take1', scope: 'server', description: "SSL Server Private Key file ('/path/to/file' - PEM or DER encoded)" },
  { name: 'SSLCertificateChainFile', arity: 'take1', scope: 'server', description: "SSL Server CA Certificate Chain file ('/path/to/file' - PEM encoded)" },
  { name: 'SSLSessionTicketKeyFile', arity: 'take1', scope: 'server', description: "TLS session ticket encryption/decryption key file (RFC 5077) ('/path/to/file' - file with 48 bytes of random data)" },
  { name: 'SSLCACertificatePath', arity: 'take1', scope: 'server', description: "SSL CA Certificate path ('/path/to/dir' - contains PEM encoded files)" },
  { name: 'SSLCACertificateFile', arity: 'take1', scope: 'server', description: "SSL CA Certificate file ('/path/to/file' - PEM encoded)" },
  { name: 'SSLCADNRequestPath', arity: 'take1', scope: 'server', description: "SSL CA Distinguished Name path ('/path/to/dir' - symlink hashes to PEM of acceptable CA names to request)" },
  { name: 'SSLCADNRequestFile', arity: 'take1', scope: 'server', description: "SSL CA Distinguished Name file ('/path/to/file' - PEM encoded to derive acceptable CA names to request)" },
  { name: 'SSLCARevocationPath', arity: 'take1', scope: 'server', description: "SSL CA Certificate Revocation List (CRL) path ('/path/to/dir' - contains PEM encoded files)" },
  { name: 'SSLCARevocationFile', arity: 'take1', scope: 'server', description: "SSL CA Certificate Revocation List (CRL) file ('/path/to/file' - PEM encoded)" },
  { name: 'SSLCARevocationCheck', arity: 'raw', scope: 'server', description: 'SSL CA Certificate Revocation List (CRL) checking mode' },
  { name: 'SSLVerifyClient', arity: 'take1', scope: 'server', description: "SSL Client verify type ('none', 'optional', 'require', 'optional_no_ca')" },
  { name: 'SSLVerifyDepth', arity: 'take1', scope: 'server', description: "SSL Client verify depth ('N' - number of intermediate certificates)" },
  { name: 'SSLSessionCacheTimeout', arity: 'take1', scope: 'server', description: "SSL Session Cache object lifetime ('N' - number of seconds)" },
  { name: 'SSLProtocol', arity: 'raw', scope: 'server', description: PROTOCOLS_DESCRIPTION },
  { name: 'SSLHonorCipherOrder', arity: 'flag', scope: 'server', description: "Use the server's cipher ordering preference" },
  { name: 'SSLCompression', arity: 'flag', scope: 'server', description: "Enable SSL level compression (`on', `off')" },
  { name: 'SSLSessionTickets', arity: 'flag', scope: 'server', description: "Enable or disable TLS session tickets(`on', `off')" },
  { name: 'SSLInsecureRenegotiation', arity: 'flag', scope: 'server', description: 'Enable support for insecure renegotiation' },
  { name: 'SSLStrictSNIVHostCheck', arity: 'flag', scope: 'server', description: 'Strict SNI virtual host checking' },
  { name: 'SSLUseStapling', arity: 'flag', scope: 'server', description: "SSL switch for the OCSP Stapling protocol (`on', `off')" },
  { name: 'SSLStaplingCache', arity: 'take1', scope: 'global', description: "SSL Stapling Response Cache storage (`dbm:/path/to/file')" },
  { name: 'SSLOCSPEnable', arity: 'raw', scope: 'server', description: "Enable use of OCSP to verify certificate revocation mode ('on', 'leaf', 'off')" },
  { name: 'SSLOCSPDefaultResponder', arity: 'take1', scope: 'server', description: 'URL of the default OCSP Responder' },
  { name: 'SSLOCSPOverrideResponder', arity: 'flag', scope: 'server', description: "Force use of the default responder URL ('on', 'off')" },
  { name: 'SSLOCSPResponseTimeSkew', arity: 'take1', scope: 'server', description: 'Maximum time difference in OCSP responses' },
  { name: 'SSLOCSPResponseMaxAge', arity: 'take1', scope: 'server', description: 'Maximum age of OCSP responses' },
  { name: 'SSLOCSPResponderTimeout', arity: 'take1', scope: 'server', description: 'OCSP responder query timeout' },
  { name: 'SSLOCSPUseRequestNonce', arity: 'flag', scope: 'server', description: "Whether OCSP queries use a nonce or not ('on', 'off')" },
  { name: 'SSLOCSPProxyURL', arity: 'take1', scope: 'server', description: 'Proxy URL to use for OCSP requests' },
  { name: 'SSLOCSPNoVerify', arity: 'flag', scope: 'server', description: "Do not verify OCSP Responder certificate ('on', 'off')" },
  { name: 'SSLOCSPResponderCertificateFile', arity: 'take1', scope: 'server', description: "Trusted OCSP responder certificates(`/path/to/file' - PEM encoded certificates)" },
  { name: 'SSLStaplingResponseTimeSkew', arity: 'take1', scope: 'server', description: 'SSL stapling option for maximum time difference in OCSP responses' },
  { name: 'SSLStaplingResponderTimeout', arity: 'take1', scope: 'server', description: 'SSL stapling option for OCSP responder timeout' },
  { name: 'SSLStaplingResponseMaxAge', arity: 'take1', scope: 'server', description: 'SSL stapling option for maximum age of OCSP responses' },
  { name: 'SSLStaplingStandardCacheTimeout', arity: 'take1', scope: 'server', description: 'SSL stapling option for normal OCSP Response Cache Lifetime' },
  { name: 'SSLStaplingReturnResponderErrors', arity: 'flag', scope: 'server', description: "SSL stapling switch to return Status Errors Back to Client(`on', `off')" },
  { name: 'SSLStaplingFakeTryLater', arity: 'flag', scope: 'server', description: "SSL stapling switch to send tryLater response to client on error (`on', `off')" },
  { name: 'SSLStaplingErrorCacheTimeout', arity: 'take1', scope: 'server', description: 'SSL stapling option for OCSP Response Error Cache Lifetime' },
  { name: 'SSLStaplingForceURL', arity: 'take1', scope: 'server', description: 'SSL stapling option to Force the OCSP Stapling URL' },
  { name: 'SSLOpenSSLConfCmd', arity: 'take2', scope: 'server', description: 'OpenSSL configuration command' },
];

const BY_NAME: ReadonlyMap<string, ApacheSslSpec> = new Map(SPECS.map((spec) => [spec.name.toLowerCase(), spec]));

export function isApacheSslDirective(name: string): boolean {
  return BY_NAME.has(name.toLowerCase());
}

export function apacheSslDirectiveSpecs(): readonly ApacheSslSpec[] {
  return SPECS;
}

const ARITY_TEXT: Readonly<Record<Exclude<Arity, 'raw' | 'flag'>, string>> = {
  take1: 'takes one argument',
  take2: 'takes two arguments',
  take12: 'takes one or two arguments',
  take23: 'takes two or three arguments',
};

export const SSL_PROTOCOL_BITS = ['SSLv3', 'TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const;
export type ApacheProtocol = (typeof SSL_PROTOCOL_BITS)[number];

export function parseApacheProtocol(directive: string, argument: string): { readonly protocols: ReadonlySet<ApacheProtocol> | null; readonly error: string | null } {
  let options = new Set<ApacheProtocol>();
  let anySet = false;
  const all: readonly ApacheProtocol[] = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
  for (const word of argument.split(/\s+/).filter((w) => w.length > 0)) {
    let action = '';
    let token = word;
    if (token.startsWith('+') || token.startsWith('-')) { action = token[0]; token = token.slice(1); }
    let bits: readonly ApacheProtocol[];
    const lowered = token.toLowerCase();
    if (lowered === 'sslv2') {
      if (action === '-') continue;
      return { protocols: null, error: 'SSLProtocol: SSLv2 is no longer supported' };
    } else if (lowered === 'sslv3') {
      if (action !== '-') return { protocols: null, error: 'SSLv3 not supported by this version of OpenSSL' };
      continue;
    } else if (lowered === 'tlsv1') bits = ['TLSv1'];
    else if (lowered === 'tlsv1.1') bits = ['TLSv1.1'];
    else if (lowered === 'tlsv1.2') bits = ['TLSv1.2'];
    else if (lowered === 'tlsv1.3') bits = ['TLSv1.3'];
    else if (lowered === 'all') bits = all;
    else return { protocols: null, error: `${directive}: Illegal protocol '${token}'` };
    if (action === '-') {
      for (const bit of bits) options.delete(bit);
    } else if (action === '+') {
      for (const bit of bits) options.add(bit);
    } else {
      if (anySet && options.size > 0) options = new Set();
      options = new Set(bits);
    }
    anySet = true;
  }
  return { protocols: options, error: null };
}

export function contiguousProtocols(enabled: ReadonlySet<ApacheProtocol>): readonly ApacheProtocol[] {
  const order: readonly ApacheProtocol[] = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
  const present = order.filter((p) => enabled.has(p));
  if (present.length === 0) return [];
  const highest = order.indexOf(present[present.length - 1]);
  let lowest = highest;
  while (lowest > 0 && enabled.has(order[lowest - 1])) lowest--;
  return order.slice(lowest, highest + 1);
}

function atoi(text: string): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const CRL_FLAGS = ['no_crl_for_cert_ok'];

export interface ApacheCrlCheck {
  readonly mode: 'none' | 'leaf' | 'chain';
  readonly noCrlForCertOk: boolean;
}

export function parseCrlCheck(argument: string): { readonly value: ApacheCrlCheck | null; readonly error: string | null } {
  let mode: ApacheCrlCheck['mode'] = 'none';
  let noCrlForCertOk = false;
  for (const word of argument.split(/\s+/).filter((w) => w.length > 0)) {
    const lowered = word.toLowerCase();
    if (lowered === 'none') mode = 'none';
    else if (lowered === 'leaf') mode = 'leaf';
    else if (lowered === 'chain') mode = 'chain';
    else if (CRL_FLAGS.includes(lowered)) noCrlForCertOk = true;
    else return { value: null, error: `SSLCARevocationCheck: Invalid argument '${word}'` };
  }
  return { value: { mode, noCrlForCertOk }, error: null };
}

export type ApacheVerifyClient = 'none' | 'optional' | 'require' | 'optional_no_ca';

export function parseVerifyClient(
  directive: string, argument: string,
): { readonly mode: ApacheVerifyClient; readonly error: null } | { readonly mode: null; readonly error: string } {
  const lowered = argument.toLowerCase();
  if (lowered === 'none' || lowered === 'off') return { mode: 'none', error: null };
  if (lowered === 'optional') return { mode: 'optional', error: null };
  if (lowered === 'require' || lowered === 'on') return { mode: 'require', error: null };
  if (lowered === 'optional_no_ca') return { mode: 'optional_no_ca', error: null };
  return { mode: null, error: `${directive}: Invalid argument '${argument}'` };
}

export function checkApacheSslDirective(directive: ApacheSslDirective): string | null {
  const spec = BY_NAME.get(directive.name.toLowerCase());
  if (!spec) return null;
  const { args } = directive;
  const lacking = (text: string): string => `${spec.name} ${text}, ${spec.description}`;
  switch (spec.arity) {
    case 'take1': if (args.length !== 1) return lacking(ARITY_TEXT.take1); break;
    case 'take2': if (args.length !== 2) return lacking(ARITY_TEXT.take2); break;
    case 'take12': if (args.length < 1 || args.length > 2) return lacking(ARITY_TEXT.take12); break;
    case 'take23': if (args.length < 2 || args.length > 3) return lacking(ARITY_TEXT.take23); break;
    case 'flag':
      if (args.length !== 1) return lacking(ARITY_TEXT.take1);
      if (!/^(on|off)$/i.test(args[0])) return `${spec.name} must be On or Off`;
      break;
    default: break;
  }
  return null;
}

export interface ApacheSslSettings {
  readonly engine: boolean;
  readonly certificateFiles: readonly string[];
  readonly certificateKeyFiles: readonly string[];
  readonly certificateChainFile: string | null;
  readonly sessionTicketKeyFile: string | null;
  readonly caCertificateFile: string | null;
  readonly caCertificatePath: string | null;
  readonly caDnRequestFile: string | null;
  readonly caRevocationFile: string | null;
  readonly caRevocationPath: string | null;
  readonly crlCheck: ApacheCrlCheck;
  readonly verifyClient: ApacheVerifyClient;
  readonly verifyDepth: number;
  readonly sessionCacheTimeout: number;
  readonly sessionCache: string;
  readonly protocols: ReadonlySet<ApacheProtocol>;
  readonly cipherSuite: string | null;
  readonly tls13Ciphers: string | null;
  readonly honorCipherOrder: boolean;
  readonly compression: boolean;
  readonly sessionTickets: boolean;
  readonly insecureRenegotiation: boolean;
  readonly strictSniVhostCheck: boolean;
  readonly useStapling: boolean;
  readonly stapling: { readonly cache: string | null };
  readonly ocsp: { readonly mode: 'off' | 'leaf' | 'chain'; readonly noOcspForCertOk: boolean };
  readonly ocspDefaultResponder: string | null;
  readonly ocspOverrideResponder: boolean;
  readonly ocspResponseTimeSkew: number;
  readonly ocspResponseMaxAge: number;
  readonly ocspUseRequestNonce: boolean;
  readonly ocspNoVerify: boolean;
  readonly ocspResponderCertificateFile: string | null;
  readonly ocspResponderTimeout: number;
  readonly ocspProxyUrl: string | null;
  readonly staplingForceUrl: string | null;
  readonly staplingResponseTimeSkew: number;
  readonly staplingResponseMaxAge: number;
  readonly staplingStandardCacheTimeout: number;
  readonly staplingErrorCacheTimeout: number;
  readonly staplingResponderTimeout: number;
  readonly staplingReturnResponderErrors: boolean;
  readonly staplingFakeTryLater: boolean;
  readonly confCommands: readonly (readonly [string, string])[];
  readonly passPhraseDialog: string;
}

export const DEFAULT_APACHE_PROTOCOLS: ReadonlySet<ApacheProtocol> = new Set<ApacheProtocol>(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
export const DEFAULT_APACHE_SESSION_TIMEOUT = 300;
export const DEFAULT_APACHE_CIPHER_SUITE = 'ALL:!COMPLEMENTOFDEFAULT:!eNULL:!aNULL:!eNULL:!EXP';

export type ApacheSslResolution =
  | { readonly ok: true; readonly settings: ApacheSslSettings }
  | { readonly ok: false; readonly directive: ApacheSslDirective; readonly error: string };

function applyDirectives(
  directives: readonly ApacheSslDirective[], base: Partial<MutableSettings>,
): { readonly directive: ApacheSslDirective; readonly error: string } | null {
  for (const directive of directives) {
    const name = directive.name.toLowerCase();
    const value = directive.args[0] ?? '';
    const flag = /^on$/i.test(value);
    switch (name) {
      case 'sslengine': base.engine = /^on$/i.test(value) || /^optional$/i.test(value); break;
      case 'sslcertificatefile': (base.certificateFiles ??= []).push(value); break;
      case 'sslcertificatekeyfile': (base.certificateKeyFiles ??= []).push(value); break;
      case 'sslcertificatechainfile': base.certificateChainFile = value; break;
      case 'sslsessionticketkeyfile': base.sessionTicketKeyFile = value; break;
      case 'sslcacertificatefile': base.caCertificateFile = value; break;
      case 'sslcacertificatepath': base.caCertificatePath = value; break;
      case 'sslcadnrequestfile': base.caDnRequestFile = value; break;
      case 'sslcarevocationfile': base.caRevocationFile = value; break;
      case 'sslcarevocationpath': base.caRevocationPath = value; break;
      case 'sslcarevocationcheck': {
        const parsed = parseCrlCheck(directive.args.join(' '));
        if (parsed.error !== null) return { directive, error: parsed.error };
        base.crlCheck = parsed.value!;
        break;
      }
      case 'sslverifyclient': {
        const parsed = parseVerifyClient(directive.name, value);
        if (parsed.error !== null) return { directive, error: parsed.error };
        base.verifyClient = parsed.mode;
        break;
      }
      case 'sslverifydepth': {
        const depth = atoi(value);
        if (depth < 0) return { directive, error: `${directive.name}: Invalid argument '${value}'` };
        base.verifyDepth = depth;
        break;
      }
      case 'sslsessioncachetimeout': {
        const timeout = atoi(value);
        if (timeout < 0) return { directive, error: 'SSLSessionCacheTimeout: Invalid argument' };
        base.sessionCacheTimeout = timeout;
        break;
      }
      case 'sslsessioncache': base.sessionCache = value; break;
      case 'sslprotocol': {
        const parsed = parseApacheProtocol(directive.name, directive.args.join(' '));
        if (parsed.error !== null) return { directive, error: parsed.error };
        base.protocols = parsed.protocols!;
        break;
      }
      case 'sslciphersuite': {
        const [first, second] = directive.args;
        const type = second === undefined ? 'SSL' : first;
        const text = second === undefined ? first : second;
        if (type === 'SSL') base.cipherSuite = `${text}:!aNULL:!eNULL:!EXP`;
        else if (type === 'TLSv1.3') base.tls13Ciphers = text;
        else return { directive, error: `protocol '${type}' not supported` };
        break;
      }
      case 'sslhonorcipherorder': base.honorCipherOrder = flag; break;
      case 'sslcompression':
        if (flag) return { directive, error: 'This version of OpenSSL does not have any compression methods available, cannot enable SSLCompression.' };
        base.compression = false;
        break;
      case 'sslsessiontickets': base.sessionTickets = flag; break;
      case 'sslinsecurerenegotiation': base.insecureRenegotiation = flag; break;
      case 'sslstrictsnivhostcheck': base.strictSniVhostCheck = flag; break;
      case 'sslusestapling': base.useStapling = flag; break;
      case 'sslstaplingcache': base.stapling = { cache: value }; break;
      case 'sslocspenable': {
        const words = directive.args.join(' ').split(/\s+/).filter((w) => w.length > 0);
        const first = (words[0] ?? '').toLowerCase();
        if (first !== 'off' && first !== 'leaf' && first !== 'on') {
          return { directive, error: `${directive.name}: Invalid argument '${words[0] ?? ''}'` };
        }
        let lenient = false;
        for (const word of words.slice(1)) {
          if (word.toLowerCase() === 'no_ocsp_for_cert_ok') lenient = true;
          else return { directive, error: `${directive.name}: Invalid argument '${word}'` };
        }
        base.ocsp = { mode: first === 'on' ? 'chain' : first, noOcspForCertOk: lenient };
        break;
      }
      case 'sslocspdefaultresponder': base.ocspDefaultResponder = value; break;
      case 'sslocspoverrideresponder': base.ocspOverrideResponder = flag; break;
      case 'sslocspresponsetimeskew': case 'sslocspresponsemaxage': case 'sslstaplingresponsetimeskew': case 'sslstaplingresponsemaxage': {
        const seconds = atoi(value);
        if (seconds < 0) return { directive, error: `${directive.name}: invalid argument` };
        if (name === 'sslocspresponsetimeskew') base.ocspResponseTimeSkew = seconds;
        else if (name === 'sslocspresponsemaxage') base.ocspResponseMaxAge = seconds;
        else if (name === 'sslstaplingresponsetimeskew') base.staplingResponseTimeSkew = seconds;
        else base.staplingResponseMaxAge = seconds;
        break;
      }
      case 'sslocsprespondertimeout': base.ocspResponderTimeout = atoi(value); break;
      case 'sslocspuserequestnonce': base.ocspUseRequestNonce = flag; break;
      case 'sslocspproxyurl': base.ocspProxyUrl = value; break;
      case 'sslocspnoverify': base.ocspNoVerify = flag; break;
      case 'sslocsprespondercertificatefile': base.ocspResponderCertificateFile = value; break;
      case 'sslstaplingstandardcachetimeout': base.staplingStandardCacheTimeout = atoi(value); break;
      case 'sslstaplingerrorcachetimeout': base.staplingErrorCacheTimeout = atoi(value); break;
      case 'sslstaplingrespondertimeout': base.staplingResponderTimeout = atoi(value); break;
      case 'sslstaplingreturnrespondererrors': base.staplingReturnResponderErrors = flag; break;
      case 'sslstaplingfaketrylater': base.staplingFakeTryLater = flag; break;
      case 'sslstaplingforceurl': base.staplingForceUrl = value; break;
      case 'sslpassphrasedialog': base.passPhraseDialog = value; break;
      case 'sslopensslconfcmd': (base.confCommands ??= []).push([directive.args[0], directive.args[1]]); break;
      default: break;
    }
  }
  return null;
}

type MutableSettings = { -readonly [K in keyof ApacheSslSettings]: ApacheSslSettings[K] extends readonly (infer U)[] ? U[] : ApacheSslSettings[K] };

export function resolveApacheSsl(
  globalDirectives: readonly ApacheSslDirective[], virtualHostDirectives: readonly ApacheSslDirective[],
): ApacheSslResolution {
  const layer: Partial<MutableSettings> = {};
  const failure = applyDirectives(globalDirectives, layer) ?? applyDirectives(virtualHostDirectives, layer);
  if (failure) return { ok: false, ...failure };
  const certificateFiles = layer.certificateFiles ?? [];
  const settings: ApacheSslSettings = {
    engine: layer.engine ?? false,
    certificateFiles,
    certificateKeyFiles: layer.certificateKeyFiles ?? [],
    certificateChainFile: layer.certificateChainFile ?? null,
    sessionTicketKeyFile: layer.sessionTicketKeyFile ?? null,
    caCertificateFile: layer.caCertificateFile ?? null,
    caCertificatePath: layer.caCertificatePath ?? null,
    caDnRequestFile: layer.caDnRequestFile ?? null,
    caRevocationFile: layer.caRevocationFile ?? null,
    caRevocationPath: layer.caRevocationPath ?? null,
    crlCheck: layer.crlCheck ?? { mode: 'none', noCrlForCertOk: false },
    verifyClient: layer.verifyClient ?? 'none',
    verifyDepth: layer.verifyDepth ?? 1,
    sessionCacheTimeout: layer.sessionCacheTimeout ?? DEFAULT_APACHE_SESSION_TIMEOUT,
    sessionCache: layer.sessionCache ?? 'none',
    protocols: layer.protocols ?? DEFAULT_APACHE_PROTOCOLS,
    cipherSuite: layer.cipherSuite ?? null,
    tls13Ciphers: layer.tls13Ciphers ?? null,
    honorCipherOrder: layer.honorCipherOrder ?? false,
    compression: layer.compression ?? false,
    sessionTickets: layer.sessionTickets ?? true,
    insecureRenegotiation: layer.insecureRenegotiation ?? false,
    strictSniVhostCheck: layer.strictSniVhostCheck ?? false,
    useStapling: layer.useStapling ?? false,
    stapling: layer.stapling ?? { cache: null },
    ocsp: layer.ocsp ?? { mode: 'off', noOcspForCertOk: false },
    ocspDefaultResponder: layer.ocspDefaultResponder ?? null,
    ocspOverrideResponder: layer.ocspOverrideResponder ?? false,
    ocspResponseTimeSkew: layer.ocspResponseTimeSkew ?? 300,
    ocspResponseMaxAge: layer.ocspResponseMaxAge ?? -1,
    ocspUseRequestNonce: layer.ocspUseRequestNonce ?? true,
    ocspNoVerify: layer.ocspNoVerify ?? false,
    ocspResponderCertificateFile: layer.ocspResponderCertificateFile ?? null,
    ocspResponderTimeout: layer.ocspResponderTimeout ?? 10,
    ocspProxyUrl: layer.ocspProxyUrl ?? null,
    staplingForceUrl: layer.staplingForceUrl ?? null,
    staplingResponseTimeSkew: layer.staplingResponseTimeSkew ?? 300,
    staplingResponseMaxAge: layer.staplingResponseMaxAge ?? -1,
    staplingStandardCacheTimeout: layer.staplingStandardCacheTimeout ?? 3600,
    staplingErrorCacheTimeout: layer.staplingErrorCacheTimeout ?? 600,
    staplingResponderTimeout: layer.staplingResponderTimeout ?? 10,
    staplingReturnResponderErrors: layer.staplingReturnResponderErrors ?? true,
    staplingFakeTryLater: layer.staplingFakeTryLater ?? true,
    confCommands: layer.confCommands ?? [],
    passPhraseDialog: layer.passPhraseDialog ?? 'builtin',
  };
  return { ok: true, settings };
}

export function sessionCacheProblem(argument: string, loadedModules: ReadonlySet<string>): string | null {
  const lowered = argument.toLowerCase();
  if (lowered === 'none' || lowered === 'nonenotnull') return null;
  const colon = argument.indexOf(':');
  const name = colon >= 0 ? argument.slice(0, colon) : argument;
  const known = ['shmcb', 'dbm', 'dc'].filter((candidate) => loadedModules.has(`socache_${candidate}`));
  if (!known.includes(name)) {
    return `SSLSessionCache: '${name}' session cache not supported (known names: ${known.join(',')}). `
      + `Maybe you need to load the appropriate socache module (mod_socache_${name}?).`;
  }
  return null;
}
