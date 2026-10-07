import { LdapRc } from './ldapErrors';
import { parseSecprops } from './sasl/saslSecprops';
import { defaultSecurityProperties, type SaslSecurityProperties } from './sasl/saslTypes';
import {
  type LdapUrlDesc, LdapUrlErr, LdapUrlParse, ldapUrlParseHosts, ldapUrlParseListExt,
} from './ldapUrl';

export const LdapVersion = { V2: 2, V3: 3 } as const;
export const LdapDeref = { NEVER: 0, SEARCHING: 1, FINDING: 2, ALWAYS: 3 } as const;
export const TlsRequireCert = { NEVER: 0, HARD: 1, DEMAND: 2, ALLOW: 3, TRY: 4 } as const;
export const LDAP_PORT_DEFAULT = 389;

export interface LdapOptions {
  version: number;
  deref: number;
  timeLimit: number;
  sizeLimit: number;
  defBase: string | null;
  defPort: number;
  urls: LdapUrlDesc[];
  referrals: boolean;
  sasl: {
    mech: string | null;
    realm: string | null;
    authcid: string | null;
    authzid: string | null;
    secprops: SaslSecurityProperties;
    noCanon: boolean;
    channelBinding: string | null;
  };
  tls: {
    certFile: string | null;
    keyFile: string | null;
    caCertFile: string | null;
    caCertDir: string | null;
    requireCert: number;
    requireSan: number;
    cipherSuite: string | null;
    protocolMin: string | null;
    protocolMax: string | null;
    crlCheck: string | null;
    crlFile: string | null;
    peerKeyHash: string | null;
    ecName: string | null;
    randFile: string | null;
  };
  timeout: number | null;
  networkTimeout: number | null;
  keepalive: { idle: number; probes: number; interval: number };
  socketBindAddresses: string | null;
}

export function defaultLdapOptions(): LdapOptions {
  const urls = ldapUrlParseListExt('ldap://localhost/', null, LdapUrlParse.NOEMPTY_HOST | LdapUrlParse.DEF_PORT).list;
  return {
    version: LdapVersion.V2,
    deref: LdapDeref.NEVER,
    timeLimit: 0,
    sizeLimit: 0,
    defBase: null,
    defPort: LDAP_PORT_DEFAULT,
    urls,
    referrals: true,
    sasl: { mech: null, realm: null, authcid: null, authzid: null, secprops: defaultSecurityProperties(), noCanon: false, channelBinding: null },
    tls: {
      certFile: null, keyFile: null, caCertFile: null, caCertDir: null,
      requireCert: TlsRequireCert.DEMAND, requireSan: TlsRequireCert.ALLOW,
      cipherSuite: null, protocolMin: null, protocolMax: null, crlCheck: null, crlFile: null,
      peerKeyHash: null, ecName: null, randFile: null,
    },
    timeout: null,
    networkTimeout: null,
    keepalive: { idle: 0, probes: 0, interval: 0 },
    socketBindAddresses: null,
  };
}

export function cloneLdapOptions(source: LdapOptions): LdapOptions {
  return {
    ...source,
    urls: source.urls.map(url => ({ ...url, attrs: url.attrs ? [...url.attrs] : null, exts: url.exts ? [...url.exts] : null })),
    sasl: { ...source.sasl, secprops: { ...source.sasl.secprops } },
    tls: { ...source.tls },
    keepalive: { ...source.keepalive },
  };
}

function cStrtolWhole(text: string): number | null {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)$/.exec(text);
  if (match === null) return null;
  return Number.parseInt(match[1], 10);
}

function cAtoi(text: string): number {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

function booleanOf(text: string): boolean {
  const lower = text.toLowerCase();
  return lower === 'on' || lower === 'yes' || lower === 'true';
}

const DEREF_KEYS: readonly (readonly [string, number])[] = [
  ['never', LdapDeref.NEVER], ['searching', LdapDeref.SEARCHING],
  ['finding', LdapDeref.FINDING], ['always', LdapDeref.ALWAYS],
];

const TLS_REQCERT_KEYS: readonly (readonly [string, number])[] = [
  ['never', TlsRequireCert.NEVER], ['no', TlsRequireCert.NEVER],
  ['hard', TlsRequireCert.HARD], ['demand', TlsRequireCert.DEMAND], ['yes', TlsRequireCert.DEMAND],
  ['allow', TlsRequireCert.ALLOW], ['try', TlsRequireCert.TRY],
];

export type OptionSource = 'sysconf' | 'userconf' | 'environment';

interface OptionDefinition {
  readonly name: string;
  readonly userOnly: boolean;
  apply(options: LdapOptions, value: string, source: OptionSource): void;
}

function positiveTimeout(value: string): number | null {
  const parsed = cStrtolWhole(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function positiveInt(value: string): number | null {
  const parsed = cStrtolWhole(value);
  return parsed !== null && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

function setUri(options: LdapOptions, value: string): void {
  const parsed = ldapUrlParseListExt(value, null, LdapUrlParse.NOEMPTY_HOST | LdapUrlParse.DEF_PORT);
  if (parsed.rc === LdapUrlErr.SUCCESS) options.urls = parsed.list;
}

function setHost(options: LdapOptions, value: string): void {
  const parsed = ldapUrlParseHosts(value, options.defPort || LDAP_PORT_DEFAULT);
  if (parsed.rc === LdapRc.SUCCESS) options.urls = parsed.list;
}

const DEFINITIONS: readonly OptionDefinition[] = [
  { name: 'TIMEOUT', userOnly: false, apply: (o, v) => { const t = positiveTimeout(v); if (t !== null) o.timeout = t; } },
  { name: 'NETWORK_TIMEOUT', userOnly: false, apply: (o, v) => { const t = positiveTimeout(v); if (t !== null) o.networkTimeout = t; } },
  { name: 'VERSION', userOnly: false, apply: (o, v) => { const t = positiveInt(v); if (t !== null) o.version = t; } },
  {
    name: 'DEREF', userOnly: false,
    apply: (o, v) => { for (const [key, deref] of DEREF_KEYS) if (key === v.toLowerCase()) o.deref = deref; },
  },
  { name: 'SIZELIMIT', userOnly: false, apply: (o, v, s) => { const n = s === 'environment' ? cAtoi(v) : cStrtolWhole(v); if (n !== null) o.sizeLimit = n; } },
  { name: 'TIMELIMIT', userOnly: false, apply: (o, v, s) => { const n = s === 'environment' ? cAtoi(v) : cStrtolWhole(v); if (n !== null) o.timeLimit = n; } },
  { name: 'BINDDN', userOnly: true, apply: () => undefined },
  { name: 'BASE', userOnly: false, apply: (o, v, s) => { o.defBase = s === 'environment' && v === '' ? null : v; } },
  { name: 'PORT', userOnly: false, apply: (o, v, s) => { const n = s === 'environment' ? cAtoi(v) : cStrtolWhole(v); if (n !== null) o.defPort = n; } },
  { name: 'HOST', userOnly: false, apply: (o, v) => setHost(o, v) },
  { name: 'URI', userOnly: false, apply: (o, v) => setUri(o, v) },
  { name: 'SOCKET_BIND_ADDRESSES', userOnly: false, apply: (o, v) => { o.socketBindAddresses = v; } },
  { name: 'REFERRALS', userOnly: false, apply: (o, v) => { o.referrals = booleanOf(v); } },
  { name: 'KEEPALIVE_IDLE', userOnly: false, apply: (o, v) => { const n = positiveInt(v); if (n !== null) o.keepalive.idle = n; } },
  { name: 'KEEPALIVE_PROBES', userOnly: false, apply: (o, v) => { const n = positiveInt(v); if (n !== null) o.keepalive.probes = n; } },
  { name: 'KEEPALIVE_INTERVAL', userOnly: false, apply: (o, v) => { const n = positiveInt(v); if (n !== null) o.keepalive.interval = n; } },
  { name: 'SASL_MECH', userOnly: false, apply: (o, v, s) => { o.sasl.mech = s === 'environment' && v === '' ? null : v; } },
  { name: 'SASL_REALM', userOnly: false, apply: (o, v, s) => { o.sasl.realm = s === 'environment' && v === '' ? null : v; } },
  { name: 'SASL_AUTHCID', userOnly: true, apply: (o, v, s) => { o.sasl.authcid = s === 'environment' && v === '' ? null : v; } },
  { name: 'SASL_AUTHZID', userOnly: true, apply: (o, v, s) => { o.sasl.authzid = s === 'environment' && v === '' ? null : v; } },
  { name: 'SASL_SECPROPS', userOnly: false, apply: (o, v) => { parseSecprops(v, o.sasl.secprops); } },
  { name: 'SASL_NOCANON', userOnly: false, apply: (o, v) => { o.sasl.noCanon = booleanOf(v); } },
  { name: 'SASL_CBINDING', userOnly: false, apply: (o, v) => { o.sasl.channelBinding = v; } },
  { name: 'TLS_CERT', userOnly: true, apply: (o, v) => { o.tls.certFile = v; } },
  { name: 'TLS_KEY', userOnly: true, apply: (o, v) => { o.tls.keyFile = v; } },
  { name: 'TLS_CACERT', userOnly: false, apply: (o, v) => { o.tls.caCertFile = v; } },
  { name: 'TLS_CACERTDIR', userOnly: false, apply: (o, v) => { o.tls.caCertDir = v; } },
  {
    name: 'TLS_REQCERT', userOnly: false,
    apply: (o, v) => { for (const [key, mode] of TLS_REQCERT_KEYS) if (key === v.toLowerCase()) o.tls.requireCert = mode; },
  },
  {
    name: 'TLS_REQSAN', userOnly: false,
    apply: (o, v) => { for (const [key, mode] of TLS_REQCERT_KEYS) if (key === v.toLowerCase()) o.tls.requireSan = mode; },
  },
  { name: 'TLS_RANDFILE', userOnly: false, apply: (o, v) => { o.tls.randFile = v; } },
  { name: 'TLS_CIPHER_SUITE', userOnly: false, apply: (o, v) => { o.tls.cipherSuite = v; } },
  { name: 'TLS_PROTOCOL_MIN', userOnly: false, apply: (o, v) => { o.tls.protocolMin = v; } },
  { name: 'TLS_PROTOCOL_MAX', userOnly: false, apply: (o, v) => { o.tls.protocolMax = v; } },
  { name: 'TLS_PEERKEY_HASH', userOnly: false, apply: (o, v) => { o.tls.peerKeyHash = v; } },
  { name: 'TLS_ECNAME', userOnly: false, apply: (o, v) => { o.tls.ecName = v; } },
  { name: 'TLS_CRLCHECK', userOnly: false, apply: (o, v) => { o.tls.crlCheck = v; } },
  { name: 'TLS_CRLFILE', userOnly: false, apply: (o, v) => { o.tls.crlFile = v; } },
];

export function applyConfigOption(
  options: LdapOptions, command: string, value: string, source: OptionSource,
): boolean {
  for (const definition of DEFINITIONS) {
    if (source === 'sysconf' && definition.userOnly) continue;
    if (definition.name.toLowerCase() !== command.toLowerCase()) continue;
    definition.apply(options, value, source);
    return true;
  }
  return false;
}

export interface ConfigHost {
  environment(name: string): string | null;
  readTextFile(path: string): string | null;
}

export const SYSTEM_CONFIG_FILE = '/etc/ldap/ldap.conf';
export const SYSTEM_CONFIG_DIRECTORY = '/etc/ldap';
export const SYSTEM_CONFIG_DEFAULTS =
  '#\n' +
  '# LDAP Defaults\n' +
  '#\n' +
  '\n' +
  '# See ldap.conf(5) for details\n' +
  '# This file should be world readable but not world writable.\n' +
  '\n' +
  '#BASE\tdc=example,dc=com\n' +
  '#URI\tldap://ldap.example.com ldap://ldap-provider.example.com:666\n' +
  '\n' +
  '#SIZELIMIT\t12\n' +
  '#TIMELIMIT\t15\n' +
  '#DEREF\t\tnever\n' +
  '\n' +
  '# TLS certificates (needed for GnuTLS)\n' +
  'TLS_CACERT\t/etc/ssl/certs/ca-certificates.crt\n';
const USER_RC_FILE = 'ldaprc';
const ENV_PREFIX = 'LDAP';

function loadConfigFile(host: ConfigHost, options: LdapOptions, path: string | null, source: OptionSource): void {
  if (path === null) return;
  const text = host.readTextFile(path);
  if (text === null) return;
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('#')) continue;
    const trimmed = rawLine.replace(/^\s+/, '').replace(/\s+$/, '');
    if (trimmed === '') continue;
    const split = /^(\S+)\s*(.*)$/s.exec(trimmed);
    if (split === null) continue;
    if (!/\s/.test(trimmed)) continue;
    applyConfigOption(options, split[1], split[2], source);
  }
}

function loadUserConfig(host: ConfigHost, options: LdapOptions, file: string): void {
  const home = host.environment('HOME');
  if (home !== null) {
    loadConfigFile(host, options, `${home}/${file}`, 'userconf');
    loadConfigFile(host, options, `${home}/.${file}`, 'userconf');
  }
  loadConfigFile(host, options, file, 'userconf');
}

export function loadGlobalOptions(host: ConfigHost): LdapOptions {
  const options = defaultLdapOptions();
  if (host.environment('LDAPNOINIT') !== null) return options;

  const user = host.environment('USER') ?? host.environment('USERNAME') ?? host.environment('LOGNAME');
  if (user !== null) options.sasl.authcid = user;

  loadConfigFile(host, options, SYSTEM_CONFIG_FILE, 'sysconf');
  loadUserConfig(host, options, USER_RC_FILE);

  const altConf = host.environment(`${ENV_PREFIX}CONF`);
  if (altConf !== null) loadConfigFile(host, options, altConf, 'sysconf');
  const altRc = host.environment(`${ENV_PREFIX}RC`);
  if (altRc !== null) loadUserConfig(host, options, altRc);

  for (const definition of DEFINITIONS) {
    const value = host.environment(`${ENV_PREFIX}${definition.name}`);
    if (value === null) continue;
    applyConfigOption(options, definition.name, value, 'environment');
  }
  return options;
}
