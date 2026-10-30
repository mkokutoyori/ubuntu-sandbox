import { gzipCompress } from '@/network/rsyslog/Zlib';
import type { HttpMessage } from '@/network/http/semantics/types';
import { isDecimal, parseNginxSize } from './NginxSsl';

export interface NginxGzipDirective {
  readonly name: string;
  readonly args: readonly string[];
}

export interface NginxGzipSettings {
  readonly enable: boolean;
  readonly vary: boolean;
  readonly minLength: number;
  readonly level: number;
  readonly proxied: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly disableMsie6: boolean;
  readonly disable: readonly RegExp[];
}

export const GZIP_MAX_BODY_BYTES = 1024 * 1024;

const ANY_TYPE = '*';
const ALWAYS_COMPRESSED_TYPE = 'text/html';
const COMPRESSIBLE_STATUSES: ReadonlySet<number> = new Set([200, 403, 404]);
const PROXIED_VALUES: ReadonlySet<string> = new Set([
  'off', 'expired', 'no-cache', 'no-store', 'private', 'no_last_modified', 'no_etag', 'auth', 'any',
]);
const HTTP_VERSIONS: ReadonlySet<string> = new Set(['1.0', '1.1']);
const MIN_LEVEL = 1;
const MAX_LEVEL = 9;

export const NGINX_GZIP_DIRECTIVES: ReadonlySet<string> = new Set([
  'gzip', 'gzip_vary', 'gzip_proxied', 'gzip_comp_level', 'gzip_min_length',
  'gzip_types', 'gzip_disable', 'gzip_http_version',
]);

export const DEFAULT_GZIP_SETTINGS: NginxGzipSettings = Object.freeze({
  enable: false,
  vary: false,
  minLength: 20,
  level: 1,
  proxied: new Set(['off']),
  types: new Set([ALWAYS_COMPRESSED_TYPE]),
  disableMsie6: false,
  disable: Object.freeze([]) as readonly RegExp[],
});

const ONE_ARGUMENT = new Set(['gzip', 'gzip_vary', 'gzip_comp_level', 'gzip_min_length', 'gzip_http_version']);
const ACCUMULATING = new Set(['gzip_types', 'gzip_disable']);

function compileDisable(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return `pcre2_compile() failed: invalid regular expression in "${pattern}"`;
  }
}

export function checkGzipDirective(
  name: string, args: readonly string[], alreadySet: boolean, parent: string | null,
): string | null {
  const allowedParents = name === 'gzip' ? ['http', 'server', 'location', 'if'] : ['http', 'server', 'location'];
  if (parent === null || !allowedParents.includes(parent)) return `"${name}" directive is not allowed here`;
  if (ONE_ARGUMENT.has(name) ? args.length !== 1 : args.length < 1) {
    return `invalid number of arguments in "${name}" directive`;
  }
  if (!ACCUMULATING.has(name) && alreadySet) return `"${name}" directive is duplicate`;
  switch (name) {
    case 'gzip':
    case 'gzip_vary': {
      const value = args[0].toLowerCase();
      return value === 'on' || value === 'off'
        ? null
        : `invalid value "${args[0]}" in "${name}" directive, it must be "on" or "off"`;
    }
    case 'gzip_comp_level': {
      if (!isDecimal(args[0])) return `"${name}" directive invalid number`;
      const level = Number(args[0]);
      return level >= MIN_LEVEL && level <= MAX_LEVEL ? null : `value must be between ${MIN_LEVEL} and ${MAX_LEVEL}`;
    }
    case 'gzip_min_length':
      return parseNginxSize(args[0]) === null ? `"${name}" directive invalid value` : null;
    case 'gzip_http_version':
      return HTTP_VERSIONS.has(args[0]) ? null : `invalid value "${args[0]}"`;
    case 'gzip_proxied': {
      const unknown = args.find((a) => !PROXIED_VALUES.has(a));
      return unknown === undefined ? null : `invalid value "${unknown}"`;
    }
    case 'gzip_disable': {
      for (const pattern of args) {
        if (pattern === 'msie6') continue;
        const compiled = compileDisable(pattern);
        if (typeof compiled === 'string') return compiled;
      }
      return null;
    }
    default:
      return null;
  }
}

export function resolveGzipSettings(
  parent: NginxGzipSettings, own: readonly NginxGzipDirective[],
): NginxGzipSettings {
  if (own.length === 0) return parent;
  let enable = parent.enable;
  let vary = parent.vary;
  let minLength = parent.minLength;
  let level = parent.level;
  let proxied = parent.proxied;
  let types = parent.types;
  let disableMsie6 = parent.disableMsie6;
  let disable = parent.disable;
  let typesDeclared = false;
  let disableDeclared = false;

  for (const directive of own) {
    const { name, args } = directive;
    if (name === 'gzip') enable = args[0].toLowerCase() === 'on';
    else if (name === 'gzip_vary') vary = args[0].toLowerCase() === 'on';
    else if (name === 'gzip_min_length') minLength = parseNginxSize(args[0]) ?? minLength;
    else if (name === 'gzip_comp_level') level = Number(args[0]);
    else if (name === 'gzip_proxied') proxied = new Set(args);
    else if (name === 'gzip_types') {
      const merged = typesDeclared ? new Set(types) : new Set([ALWAYS_COMPRESSED_TYPE]);
      for (const type of args) merged.add(type.toLowerCase());
      types = merged;
      typesDeclared = true;
    } else if (name === 'gzip_disable') {
      const merged: RegExp[] = disableDeclared ? [...disable] : [];
      if (!disableDeclared) disableMsie6 = false;
      for (const pattern of args) {
        if (pattern === 'msie6') { disableMsie6 = true; continue; }
        const compiled = compileDisable(pattern);
        if (typeof compiled !== 'string') merged.push(compiled);
      }
      disable = merged;
      disableDeclared = true;
    }
  }
  return { enable, vary, minLength, level, proxied, types, disableMsie6, disable };
}

function gzipQuantity(text: string, from: number): number {
  let cursor = from;
  const first = text[cursor++];
  if (first !== '0' && first !== '1') return 0;
  let quantity = (first.charCodeAt(0) - 48) * 100;
  if (cursor === text.length) return quantity;
  const second = text[cursor++];
  if (second === ',' || second === ' ') return quantity;
  if (second !== '.') return 0;
  let digits = 0;
  while (cursor < text.length) {
    const c = text[cursor++];
    if (c === ',' || c === ' ') break;
    if (c >= '0' && c <= '9') {
      quantity += c.charCodeAt(0) - 48;
      digits++;
      continue;
    }
    return 0;
  }
  return quantity > 100 || digits > 3 ? 0 : quantity;
}

export function acceptsGzip(header: string): boolean {
  if (header.length < 4) return false;
  if (header.startsWith('gzip,')) return true;
  const lower = header.toLowerCase();
  let at = lower.indexOf('gzip');
  while (at > 0 && lower[at - 1] !== ',' && lower[at - 1] !== ' ') at = lower.indexOf('gzip', at + 4);
  if (at < 0) return false;

  let cursor = at + 4;
  while (cursor < lower.length) {
    const c = lower[cursor++];
    if (c === ',') return true;
    if (c === ';') break;
    if (c === ' ') continue;
    return false;
  }
  if (cursor >= lower.length) return true;

  while (cursor < lower.length) {
    const c = lower[cursor++];
    if (c === 'q') {
      if (cursor + 2 > lower.length || lower[cursor] !== '=') return false;
      return gzipQuantity(lower, cursor + 1) !== 0;
    }
    if (c !== ' ') return false;
  }
  return true;
}

function isMsie6(userAgent: string): boolean {
  if (userAgent.includes('Opera')) return false;
  const at = userAgent.indexOf('MSIE ');
  if (at < 0 || at + 7 >= userAgent.length || userAgent[at + 6] !== '.') return false;
  const major = userAgent[at + 5];
  if (major === '4' || major === '5') return true;
  return major === '6' && !userAgent.includes('SV1', at + 8);
}

function hasCacheDirective(cacheControl: string, directive: string): boolean {
  return cacheControl.split(',').some((part) => part.trim().toLowerCase().split(/[=;\s]/)[0] === directive);
}

function proxiedRequestAllowed(req: HttpMessage, res: HttpMessage, proxied: ReadonlySet<string>): boolean {
  if (proxied.has('off')) return false;
  if (proxied.has('any')) return true;
  if (req.headers.has('Authorization') && proxied.has('auth')) return true;

  const expires = res.headers.get('Expires');
  if (expires !== undefined) {
    if (!proxied.has('expired')) return false;
    const at = Date.parse(expires);
    if (Number.isNaN(at)) return false;
    const dated = res.headers.get('Date');
    const now = dated === undefined ? Date.now() : Date.parse(dated);
    return !Number.isNaN(now) && at < now;
  }

  const cacheControl = res.headers.get('Cache-Control');
  if (cacheControl !== undefined) {
    return (['no-cache', 'no-store', 'private'] as const)
      .some((directive) => proxied.has(directive) && hasCacheDirective(cacheControl, directive));
  }
  if (proxied.has('no_last_modified') && res.headers.has('Last-Modified')) return false;
  if (proxied.has('no_etag') && res.headers.has('ETag')) return false;
  return true;
}

function clientAcceptsGzip(req: HttpMessage, res: HttpMessage, settings: NginxGzipSettings): boolean {
  const accept = req.headers.get('Accept-Encoding');
  if (accept === undefined || !acceptsGzip(accept)) return false;

  const userAgent = req.headers.get('User-Agent');
  if (userAgent !== undefined && settings.disableMsie6 && isMsie6(userAgent)) return false;
  if (req.headers.has('Via') && !proxiedRequestAllowed(req, res, settings.proxied)) return false;
  if (userAgent !== undefined && settings.disable.some((pattern) => pattern.test(userAgent))) return false;
  return true;
}

function contentTypeOf(res: HttpMessage): string | null {
  const raw = res.headers.get('Content-Type');
  if (raw === undefined) return null;
  const semicolon = raw.indexOf(';');
  return (semicolon < 0 ? raw : raw.slice(0, semicolon)).trim().toLowerCase();
}

function weakenEtag(res: HttpMessage): void {
  const etag = res.headers.get('ETag');
  if (etag === undefined || etag.startsWith('W/')) return;
  if (etag.startsWith('"')) res.headers.set('ETag', `W/${etag}`);
  else res.headers.delete('ETag');
}

export function applyGzipFilter(req: HttpMessage, res: HttpMessage, settings: NginxGzipSettings): void {
  if (!settings.enable) return;
  if (!COMPRESSIBLE_STATUSES.has(res.statusCode ?? 0)) return;
  if (req.method === 'HEAD') return;
  const body = res.body;
  if (body === null || body.length === 0 || body.length < settings.minLength) return;
  if (res.headers.has('Content-Encoding')) return;
  const type = contentTypeOf(res);
  if (type === null || !(settings.types.has(ANY_TYPE) || settings.types.has(type))) return;

  if (settings.vary) res.headers.append('Vary', 'Accept-Encoding');
  if (body.length > GZIP_MAX_BODY_BYTES) return;
  if (!clientAcceptsGzip(req, res, settings)) return;

  res.body = gzipCompress(body, settings.level);
  res.headers.set('Content-Encoding', 'gzip');
  res.headers.delete('Content-Length');
  res.headers.delete('Accept-Ranges');
  res.headers.set('Transfer-Encoding', 'chunked');
  weakenEtag(res);
}
