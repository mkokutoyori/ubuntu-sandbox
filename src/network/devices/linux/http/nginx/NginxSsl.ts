export interface NginxSslDirective {
  readonly name: string;
  readonly args: readonly string[];
}

type SslDirectiveKind = 'url' | 'ocspEnum' | 'ocspCache' | 'str' | 'flag' | 'size' | 'num' | 'sec' | 'enum' | 'bitmask' | 'strArray' | 'keyval' | 'sessionCache';

interface SslDirectiveSpec {
  readonly kind: SslDirectiveKind;
  readonly minArgs: number;
  readonly maxArgs: number;
}

const ONE = { minArgs: 1, maxArgs: 1 } as const;

const SSL_DIRECTIVE_SPECS: Readonly<Record<string, SslDirectiveSpec>> = {
  ssl_certificate: { kind: 'strArray', ...ONE },
  ssl_certificate_key: { kind: 'strArray', ...ONE },
  ssl_password_file: { kind: 'str', ...ONE },
  ssl_dhparam: { kind: 'str', ...ONE },
  ssl_ecdh_curve: { kind: 'str', ...ONE },
  ssl_protocols: { kind: 'bitmask', minArgs: 1, maxArgs: Infinity },
  ssl_ciphers: { kind: 'str', ...ONE },
  ssl_buffer_size: { kind: 'size', ...ONE },
  ssl_verify_client: { kind: 'enum', ...ONE },
  ssl_verify_depth: { kind: 'num', ...ONE },
  ssl_client_certificate: { kind: 'str', ...ONE },
  ssl_trusted_certificate: { kind: 'str', ...ONE },
  ssl_prefer_server_ciphers: { kind: 'flag', ...ONE },
  ssl_session_cache: { kind: 'sessionCache', minArgs: 1, maxArgs: 2 },
  ssl_session_tickets: { kind: 'flag', ...ONE },
  ssl_session_ticket_key: { kind: 'strArray', ...ONE },
  ssl_session_timeout: { kind: 'sec', ...ONE },
  ssl_crl: { kind: 'str', ...ONE },
  ssl_stapling: { kind: 'flag', ...ONE },
  ssl_stapling_file: { kind: 'str', ...ONE },
  ssl_stapling_verify: { kind: 'flag', ...ONE },
  ssl_stapling_responder: { kind: 'url', ...ONE },
  ssl_ocsp: { kind: 'ocspEnum', ...ONE },
  ssl_ocsp_responder: { kind: 'url', ...ONE },
  ssl_ocsp_cache: { kind: 'ocspCache', ...ONE },
  ssl_early_data: { kind: 'flag', ...ONE },
  ssl_conf_command: { kind: 'keyval', minArgs: 2, maxArgs: 2 },
  ssl_reject_handshake: { kind: 'flag', ...ONE },
};

export const NGINX_SSL_DIRECTIVES: ReadonlySet<string> = new Set(Object.keys(SSL_DIRECTIVE_SPECS));

export const SSL_PROTOCOL_NAMES: readonly string[] = ['SSLv2', 'SSLv3', 'TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
export const DEFAULT_SSL_PROTOCOLS: readonly string[] = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
export const DEFAULT_SSL_CIPHERS = 'HIGH:!aNULL:!MD5';
export const DEFAULT_SSL_ECDH_CURVE = 'auto';
export const DEFAULT_SSL_BUFFER_SIZE = 16384;
export const DEFAULT_SSL_SESSION_TIMEOUT = 300;
export const DEFAULT_BUILTIN_SESSION_CACHE_SIZE = -2;

const VERIFY_CLIENT_VALUES = ['off', 'on', 'optional', 'optional_no_ca'] as const;
export type NginxVerifyClient = (typeof VERIFY_CLIENT_VALUES)[number];

const PAGE_SIZE = 4096;
const OCSP_VALUES = ['off', 'on', 'leaf'] as const;
export type NginxOcspMode = (typeof OCSP_VALUES)[number];

function isDecimal(text: string): boolean {
  return /^\d+$/.test(text);
}

export function parseNginxSize(text: string): number | null {
  if (text.length === 0) return null;
  const unit = text[text.length - 1];
  const scale = unit === 'k' || unit === 'K' ? 1024 : unit === 'm' || unit === 'M' ? 1024 * 1024 : 1;
  const digits = scale === 1 ? text : text.slice(0, -1);
  if (!isDecimal(digits)) return null;
  return Number(digits) * scale;
}

const TIME_UNITS: readonly { readonly unit: string; readonly seconds: number }[] = [
  { unit: 'y', seconds: 60 * 60 * 24 * 365 }, { unit: 'M', seconds: 60 * 60 * 24 * 30 },
  { unit: 'w', seconds: 60 * 60 * 24 * 7 }, { unit: 'd', seconds: 60 * 60 * 24 },
  { unit: 'h', seconds: 60 * 60 }, { unit: 'm', seconds: 60 }, { unit: 's', seconds: 1 },
];

export function parseNginxSeconds(text: string): number | null {
  let total = 0;
  let value = '';
  let step = -1;
  let valid = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch >= '0' && ch <= '9') { value += ch; valid = true; continue; }
    if (ch === ' ') {
      if (step >= TIME_UNITS.length - 1) return null;
      step = TIME_UNITS.length;
      total += Number(value || '0');
      value = '';
      valid = false;
      continue;
    }
    const index = TIME_UNITS.findIndex((entry) => entry.unit === ch);
    if (index < 0 || index <= step) return null;
    step = index;
    total += Number(value || '0') * TIME_UNITS[index].seconds;
    value = '';
    valid = false;
  }
  if (valid) {
    if (step >= TIME_UNITS.length - 1) return null;
    total += Number(value);
  }
  return Number.isFinite(total) ? total : null;
}

export function checkSslDirective(name: string, args: readonly string[], alreadySet: boolean): string | null {
  const spec = SSL_DIRECTIVE_SPECS[name];
  if (!spec) return null;
  if (args.length < spec.minArgs || args.length > spec.maxArgs) {
    return `invalid number of arguments in "${name}" directive`;
  }
  const duplicates = spec.kind !== 'strArray' && spec.kind !== 'keyval' && spec.kind !== 'sessionCache';
  if (duplicates && alreadySet) return `"${name}" directive is duplicate`;
  switch (spec.kind) {
    case 'flag': {
      const value = args[0].toLowerCase();
      if (value !== 'on' && value !== 'off') return `invalid value "${args[0]}" in "${name}" directive, it must be "on" or "off"`;
      return null;
    }
    case 'size':
      return parseNginxSize(args[0]) === null ? `"${name}" directive invalid value` : null;
    case 'num':
      return isDecimal(args[0]) ? null : `"${name}" directive invalid number`;
    case 'sec':
      return parseNginxSeconds(args[0]) === null ? `"${name}" directive invalid value` : null;
    case 'enum':
      return (VERIFY_CLIENT_VALUES as readonly string[]).includes(args[0]) ? null : `invalid value "${args[0]}"`;
    case 'bitmask': {
      const unknown = args.find((a) => !SSL_PROTOCOL_NAMES.includes(a));
      return unknown === undefined ? null : `invalid value "${unknown}"`;
    }
    case 'sessionCache':
      return checkSessionCache(args);
    case 'ocspEnum':
      return (OCSP_VALUES as readonly string[]).includes(args[0]) ? null : `invalid value "${args[0]}"`;
    case 'ocspCache':
      return checkOcspCache(args[0]);
    case 'url':
      return /^http:\/\//i.test(args[0]) ? null : `invalid URL prefix in "${args[0]}"`;
    default:
      return null;
  }
}

function checkOcspCache(item: string): string | null {
  if (item === 'off') return null;
  if (item.length <= 'shared:'.length || !item.startsWith('shared:')) return `invalid OCSP cache "${item}"`;
  const rest = item.slice('shared:'.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return `invalid OCSP cache "${item}"`;
  const size = parseNginxSize(rest.slice(colon + 1));
  if (size === null) return `invalid OCSP cache "${item}"`;
  return size < 8 * PAGE_SIZE ? `OCSP cache "${item}" is too small` : null;
}

export interface SslSessionCacheSetting {
  readonly builtin: 'unset' | 'off' | 'none' | 'builtin';
  readonly builtinSize: number | null;
  readonly shared: { readonly name: string; readonly size: number } | null;
}

function parseSessionCacheItem(item: string): { error: string } | { builtin?: SslSessionCacheSetting['builtin']; builtinSize?: number; shared?: { name: string; size: number } } {
  if (item === 'off') return { builtin: 'off' };
  if (item === 'none') return { builtin: 'none' };
  if (item === 'builtin') return { builtin: 'builtin' };
  if (item.length > 'builtin:'.length && item.startsWith('builtin:')) {
    const digits = item.slice('builtin:'.length);
    if (!isDecimal(digits)) return { error: `invalid session cache "${item}"` };
    return { builtin: 'builtin', builtinSize: Number(digits) };
  }
  if (item.length > 'shared:'.length && item.startsWith('shared:')) {
    const rest = item.slice('shared:'.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) return { error: `invalid session cache "${item}"` };
    const size = parseNginxSize(rest.slice(colon + 1));
    if (size === null) return { error: `invalid session cache "${item}"` };
    if (size < 8 * PAGE_SIZE) return { error: `session cache "${item}" is too small` };
    return { shared: { name: rest.slice(0, colon), size } };
  }
  return { error: `invalid session cache "${item}"` };
}

function checkSessionCache(args: readonly string[]): string | null {
  for (const item of args) {
    const parsed = parseSessionCacheItem(item);
    if ('error' in parsed) return parsed.error;
  }
  return null;
}

export interface NginxSslSettings {
  readonly certificates: readonly string[];
  readonly certificateKeys: readonly string[];
  readonly passwordFile: string | null;
  readonly protocols: readonly string[];
  readonly ciphers: string;
  readonly preferServerCiphers: boolean;
  readonly ecdhCurve: string;
  readonly dhparam: string;
  readonly bufferSize: number;
  readonly verifyClient: NginxVerifyClient;
  readonly verifyDepth: number;
  readonly clientCertificate: string;
  readonly trustedCertificate: string;
  readonly crl: string;
  readonly sessionCache: SslSessionCacheSetting;
  readonly sessionTickets: boolean;
  readonly sessionTicketKeys: readonly string[];
  readonly sessionTimeout: number;
  readonly stapling: boolean;
  readonly staplingFile: string;
  readonly staplingVerify: boolean;
  readonly staplingResponder: string;
  readonly ocsp: NginxOcspMode;
  readonly ocspResponder: string;
  readonly ocspCache: string | null;
  readonly earlyData: boolean;
  readonly confCommands: readonly (readonly [string, string])[];
  readonly rejectHandshake: boolean;
}

interface SslLayer {
  certificates?: string[];
  certificateKeys?: string[];
  passwordFile?: string;
  protocols?: string[];
  ciphers?: string;
  preferServerCiphers?: boolean;
  ecdhCurve?: string;
  dhparam?: string;
  bufferSize?: number;
  verifyClient?: NginxVerifyClient;
  verifyDepth?: number;
  clientCertificate?: string;
  trustedCertificate?: string;
  crl?: string;
  sessionCacheBuiltin?: SslSessionCacheSetting['builtin'];
  sessionCacheBuiltinSize?: number;
  sessionCacheShared?: { name: string; size: number };
  sessionTickets?: boolean;
  sessionTicketKeys?: string[];
  sessionTimeout?: number;
  stapling?: boolean;
  staplingFile?: string;
  staplingVerify?: boolean;
  staplingResponder?: string;
  ocsp?: NginxOcspMode;
  ocspResponder?: string;
  ocspCache?: string;
  earlyData?: boolean;
  confCommands?: (readonly [string, string])[];
  rejectHandshake?: boolean;
}

function collectLayer(directives: readonly NginxSslDirective[]): SslLayer {
  const layer: SslLayer = {};
  const flag = (d: NginxSslDirective): boolean => d.args[0].toLowerCase() === 'on';
  for (const d of directives) {
    switch (d.name) {
      case 'ssl_certificate': (layer.certificates ??= []).push(d.args[0]); break;
      case 'ssl_certificate_key': (layer.certificateKeys ??= []).push(d.args[0]); break;
      case 'ssl_password_file': layer.passwordFile = d.args[0]; break;
      case 'ssl_protocols': layer.protocols = [...d.args]; break;
      case 'ssl_ciphers': layer.ciphers = d.args[0]; break;
      case 'ssl_prefer_server_ciphers': layer.preferServerCiphers = flag(d); break;
      case 'ssl_ecdh_curve': layer.ecdhCurve = d.args[0]; break;
      case 'ssl_dhparam': layer.dhparam = d.args[0]; break;
      case 'ssl_buffer_size': layer.bufferSize = parseNginxSize(d.args[0]) ?? undefined; break;
      case 'ssl_verify_client': layer.verifyClient = d.args[0] as NginxVerifyClient; break;
      case 'ssl_verify_depth': layer.verifyDepth = Number(d.args[0]); break;
      case 'ssl_client_certificate': layer.clientCertificate = d.args[0]; break;
      case 'ssl_trusted_certificate': layer.trustedCertificate = d.args[0]; break;
      case 'ssl_crl': layer.crl = d.args[0]; break;
      case 'ssl_session_cache':
        for (const item of d.args) {
          const parsed = parseSessionCacheItem(item);
          if ('error' in parsed) continue;
          if (parsed.builtin !== undefined) layer.sessionCacheBuiltin = parsed.builtin;
          if (parsed.builtinSize !== undefined) layer.sessionCacheBuiltinSize = parsed.builtinSize;
          if (parsed.shared !== undefined) layer.sessionCacheShared = parsed.shared;
        }
        break;
      case 'ssl_session_tickets': layer.sessionTickets = flag(d); break;
      case 'ssl_session_ticket_key': (layer.sessionTicketKeys ??= []).push(d.args[0]); break;
      case 'ssl_session_timeout': layer.sessionTimeout = parseNginxSeconds(d.args[0]) ?? undefined; break;
      case 'ssl_stapling': layer.stapling = flag(d); break;
      case 'ssl_stapling_file': layer.staplingFile = d.args[0]; break;
      case 'ssl_stapling_verify': layer.staplingVerify = flag(d); break;
      case 'ssl_stapling_responder': layer.staplingResponder = d.args[0]; break;
      case 'ssl_ocsp': layer.ocsp = d.args[0] as NginxOcspMode; break;
      case 'ssl_ocsp_responder': layer.ocspResponder = d.args[0]; break;
      case 'ssl_ocsp_cache': layer.ocspCache = d.args[0]; break;
      case 'ssl_early_data': layer.earlyData = flag(d); break;
      case 'ssl_conf_command': (layer.confCommands ??= []).push([d.args[0], d.args[1]]); break;
      case 'ssl_reject_handshake': layer.rejectHandshake = flag(d); break;
    }
  }
  return layer;
}

export function resolveSslSettings(
  parentDirectives: readonly NginxSslDirective[], childDirectives: readonly NginxSslDirective[],
): NginxSslSettings {
  const prev = collectLayer(parentDirectives);
  const conf = collectLayer(childDirectives);
  const pick = <K extends keyof SslLayer>(key: K): SslLayer[K] => conf[key] ?? prev[key];
  const builtin = pick('sessionCacheBuiltin');
  const shared = conf.sessionCacheShared ?? prev.sessionCacheShared ?? null;
  const resolvedBuiltin = builtin ?? (shared ? 'off' : 'none');
  return {
    certificates: pick('certificates') ?? [],
    certificateKeys: pick('certificateKeys') ?? [],
    passwordFile: pick('passwordFile') ?? null,
    protocols: pick('protocols') ?? DEFAULT_SSL_PROTOCOLS,
    ciphers: pick('ciphers') ?? DEFAULT_SSL_CIPHERS,
    preferServerCiphers: pick('preferServerCiphers') ?? false,
    ecdhCurve: pick('ecdhCurve') ?? DEFAULT_SSL_ECDH_CURVE,
    dhparam: pick('dhparam') ?? '',
    bufferSize: pick('bufferSize') ?? DEFAULT_SSL_BUFFER_SIZE,
    verifyClient: pick('verifyClient') ?? 'off',
    verifyDepth: pick('verifyDepth') ?? 1,
    clientCertificate: pick('clientCertificate') ?? '',
    trustedCertificate: pick('trustedCertificate') ?? '',
    crl: pick('crl') ?? '',
    sessionCache: {
      builtin: resolvedBuiltin,
      builtinSize: pick('sessionCacheBuiltinSize') ?? null,
      shared,
    },
    sessionTickets: pick('sessionTickets') ?? true,
    sessionTicketKeys: pick('sessionTicketKeys') ?? [],
    sessionTimeout: pick('sessionTimeout') ?? DEFAULT_SSL_SESSION_TIMEOUT,
    stapling: pick('stapling') ?? false,
    staplingFile: pick('staplingFile') ?? '',
    staplingVerify: pick('staplingVerify') ?? false,
    staplingResponder: pick('staplingResponder') ?? '',
    ocsp: pick('ocsp') ?? 'off',
    ocspResponder: pick('ocspResponder') ?? '',
    ocspCache: pick('ocspCache') ?? null,
    earlyData: pick('earlyData') ?? false,
    confCommands: pick('confCommands') ?? [],
    rejectHandshake: pick('rejectHandshake') ?? false,
  };
}

export function sslMergeProblem(settings: NginxSslSettings, serves: boolean): string | null {
  const { certificates, certificateKeys } = settings;
  if (certificates.length > 0 && certificateKeys.length < certificates.length) {
    return `no "ssl_certificate_key" is defined for certificate "${certificates[certificates.length - 1]}"`;
  }
  if (serves && certificates.length === 0 && !settings.rejectHandshake) {
    return 'no "ssl_certificate" is defined for the "listen ... ssl" directive';
  }
  if (settings.verifyClient !== 'off' && settings.clientCertificate === '' && settings.verifyClient !== 'optional_no_ca') {
    return 'no ssl_client_certificate for ssl_verify_client';
  }
  if (settings.ocsp !== 'off' && settings.verifyClient === 'optional_no_ca') {
    return '"ssl_ocsp" is incompatible with "ssl_verify_client optional_no_ca"';
  }
  return null;
}

export const SSL_CLIENT_ERROR_PAGES: Readonly<Record<495 | 496, { readonly title: string; readonly body: string }>> = {
  495: { title: '400 The SSL certificate error', body: 'The SSL certificate error' },
  496: { title: '400 No required SSL certificate was sent', body: 'No required SSL certificate was sent' },
};

const OPTIONAL_VERIFY_ERRORS: ReadonlySet<string> = new Set([
  'unknown', 'untrusted', 'self-signed',
]);

export type ClientVerdict =
  | { readonly outcome: 'pass'; readonly verify: 'NONE' | 'SUCCESS' | 'FAILED' }
  | { readonly outcome: 'reject'; readonly status: 495 | 496 };

export function clientCertificateVerdict(
  mode: NginxVerifyClient, presented: boolean, reason: string | null,
): ClientVerdict {
  if (mode === 'off') return { outcome: 'pass', verify: 'NONE' };
  if (presented && reason !== null) {
    if (mode !== 'optional_no_ca' || !OPTIONAL_VERIFY_ERRORS.has(reason)) return { outcome: 'reject', status: 495 };
    return { outcome: 'pass', verify: 'FAILED' };
  }
  if (mode === 'on' && !presented) return { outcome: 'reject', status: 496 };
  return { outcome: 'pass', verify: presented ? 'SUCCESS' : 'NONE' };
}
