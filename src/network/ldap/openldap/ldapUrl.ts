import { LdapRc } from './ldapErrors';
import { LdapDebug, type LdapLog } from './ldapLog';

export const LdapUrlErr = {
  SUCCESS: 0x00,
  MEM: 0x01,
  PARAM: 0x02,
  BADSCHEME: 0x03,
  BADENCLOSURE: 0x04,
  BADURL: 0x05,
  BADHOST: 0x06,
  BADATTRS: 0x07,
  BADSCOPE: 0x08,
  BADFILTER: 0x09,
  BADEXTS: 0x0a,
} as const;

export const LdapScope = {
  BASE: 0,
  ONELEVEL: 1,
  SUBTREE: 2,
  SUBORDINATE: 3,
  DEFAULT: -1,
} as const;

export const LdapUrlParse = {
  NONE: 0x00,
  NOEMPTY_HOST: 0x01,
  DEF_PORT: 0x02,
  NOEMPTY_DN: 0x04,
  NODEF_SCOPE: 0x08,
  HISTORIC: 0x0b,
} as const;

export const LDAP_PORT = 389;
export const LDAPS_PORT = 636;

export interface LdapUrlDesc {
  scheme: string;
  host: string | null;
  port: number;
  dn: string | null;
  attrs: string[] | null;
  scope: number;
  filter: string | null;
  exts: string[] | null;
  critExts: number;
}

export type LdapUrlProto = 'tcp' | 'ipc';

const PREFIXES: readonly string[] = ['ldap://', 'pldap://', 'ldaps://', 'pldaps://', 'ldapi://'];

function startsWithIgnoreCase(text: string, prefix: string): boolean {
  return text.length >= prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix;
}

function skipUrlPrefix(url: string): { rest: string; enclosed: boolean; scheme: string } | null {
  let p = url;
  let enclosed = false;
  if (p.startsWith('<')) {
    enclosed = true;
    p = p.slice(1);
  }
  if (startsWithIgnoreCase(p, 'url:')) p = p.slice(4);
  for (const prefix of PREFIXES) {
    if (startsWithIgnoreCase(p, prefix)) {
      return { rest: p.slice(prefix.length), enclosed, scheme: prefix.slice(0, prefix.length - 3) };
    }
  }
  return null;
}

export function ldapIsLdapUrl(url: string): boolean {
  return skipUrlPrefix(url) !== null;
}

export function ldapIsLdapsUrl(url: string): boolean {
  const skipped = skipUrlPrefix(url);
  return skipped !== null && (skipped.scheme === 'ldaps' || skipped.scheme === 'pldaps');
}

export function ldapIsLdapiUrl(url: string): boolean {
  const skipped = skipUrlPrefix(url);
  return skipped !== null && skipped.scheme === 'ldapi';
}

export function urlScheme2Proto(scheme: string): LdapUrlProto | null {
  if (scheme === 'ldap' || scheme === 'pldap' || scheme === 'ldaps' || scheme === 'pldaps') return 'tcp';
  if (scheme === 'ldapi') return 'ipc';
  return null;
}

export function urlSchemePort(scheme: string, port: number): number {
  if (port) return port;
  if (scheme === 'ldap' || scheme === 'pldap') return LDAP_PORT;
  if (scheme === 'ldaps' || scheme === 'pldaps') return LDAPS_PORT;
  return -1;
}

export function urlScheme2Tls(scheme: string): boolean {
  return scheme === 'ldaps' || scheme === 'pldaps';
}

const SCOPE_NAMES: readonly (readonly [string, number])[] = [
  ['one', LdapScope.ONELEVEL],
  ['onelevel', LdapScope.ONELEVEL],
  ['base', LdapScope.BASE],
  ['sub', LdapScope.SUBTREE],
  ['subtree', LdapScope.SUBTREE],
  ['subord', LdapScope.SUBORDINATE],
  ['subordinate', LdapScope.SUBORDINATE],
  ['children', LdapScope.SUBORDINATE],
];

export function pvtStr2Scope(text: string): number {
  const lower = text.toLowerCase();
  for (const [name, scope] of SCOPE_NAMES) if (name === lower) return scope;
  return -1;
}

export function pvtScope2Str(scope: number): string | null {
  switch (scope) {
    case LdapScope.BASE: return 'base';
    case LdapScope.ONELEVEL: return 'one';
    case LdapScope.SUBTREE: return 'sub';
    case LdapScope.SUBORDINATE: return 'subordinate';
    default: return null;
  }
}

function isHexPair(text: string, at: number): boolean {
  for (let i = 0; i < 2; i++) {
    const c = text[at + i];
    if (c === undefined || !/[0-9A-Fa-f]/.test(c)) return false;
  }
  return true;
}

export function pvtHexUnescape(text: string): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '%') {
      if (!isHexPair(text, i + 1)) return '';
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const codePoint = text.codePointAt(i)!;
    const width = codePoint > 0xffff ? 2 : 1;
    for (const byte of encoder.encode(text.slice(i, i + width))) bytes.push(byte);
    i += width;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function str2CharArray(text: string, breakChars: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const c of text) {
    if (breakChars.includes(c)) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

function emptyDesc(scheme: string, scope: number): LdapUrlDesc {
  return { scheme, host: null, port: 0, dn: null, attrs: null, scope, filter: null, exts: null, critExts: 0 };
}

export interface LdapUrlParseResult {
  rc: number;
  desc: LdapUrlDesc | null;
}

function fail(rc: number): LdapUrlParseResult {
  return { rc, desc: null };
}

function cStrtol(text: string): { value: number; rest: string; consumed: boolean } {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  if (match === null) return { value: 0, rest: text, consumed: false };
  return { value: Number.parseInt(match[1], 10), rest: text.slice(match[0].length), consumed: true };
}

export function ldapUrlParseExt(urlIn: string, flags: number, log?: LdapLog): LdapUrlParseResult {
  log?.debug(LdapDebug.TRACE, `ldap_url_parse_ext(${urlIn})\n`);
  const skipped = skipUrlPrefix(urlIn);
  if (skipped === null) return fail(LdapUrlErr.BADSCHEME);
  const proto = urlScheme2Proto(skipped.scheme);
  if (proto === null) return fail(LdapUrlErr.BADSCHEME);

  let url = skipped.rest;
  if (skipped.enclosed) {
    if (url === '') return fail(LdapUrlErr.BADENCLOSURE);
    if (!url.endsWith('>')) return fail(LdapUrlErr.BADENCLOSURE);
    url = url.slice(0, -1);
  }

  const desc = emptyDesc(
    skipped.scheme,
    (flags & LdapUrlParse.NODEF_SCOPE) !== 0 ? LdapScope.BASE : LdapScope.DEFAULT,
  );

  let p: string | null;
  let q: string | null = null;
  const slash = url.indexOf('/');
  if (slash >= 0) {
    p = url.slice(slash + 1);
    url = url.slice(0, slash);
  } else {
    const question = url.indexOf('?');
    if (question >= 0) {
      q = url.slice(question + 1);
      url = url.slice(0, question);
    }
    p = null;
  }

  if (proto !== 'ipc') {
    q = null;
    let portText: string | null = null;
    if (url.startsWith('[')) {
      const close = url.indexOf(']');
      if (close < 0) return fail(LdapUrlErr.BADURL);
      const tail = url.slice(close + 1);
      url = url.slice(1, close);
      const colon = tail.indexOf(':');
      if (colon > 0) return fail(LdapUrlErr.BADURL);
      if (colon === 0) portText = tail.slice(1);
    } else {
      const colon = url.indexOf(':');
      if (colon >= 0) {
        portText = url.slice(colon + 1);
        url = url.slice(0, colon);
      }
    }
    if (portText !== null) {
      const rc = parsePort(portText, desc);
      if (rc !== LdapUrlErr.SUCCESS) return fail(rc);
    }
    if ((flags & LdapUrlParse.DEF_PORT) !== 0 && desc.port === 0) {
      desc.port = desc.scheme === 'ldaps' ? LDAPS_PORT : LDAP_PORT;
    }
  }

  desc.host = pvtHexUnescape(url);
  if ((flags & LdapUrlParse.NOEMPTY_HOST) !== 0 && desc.host === '') desc.host = null;

  if (p === null && q !== null && q.startsWith('?')) {
    q = q.slice(1);
    if (q !== '') desc.dn = pvtHexUnescape(q);
    else if ((flags & LdapUrlParse.NOEMPTY_DN) === 0) desc.dn = '';
  }

  if (p === null) return { rc: LdapUrlErr.SUCCESS, desc };

  const rest = splitField(p);
  if (rest.field !== '') desc.dn = pvtHexUnescape(rest.field);
  else if ((flags & LdapUrlParse.NOEMPTY_DN) === 0) desc.dn = '';
  if (rest.next === null) return { rc: LdapUrlErr.SUCCESS, desc };

  const attrs = splitField(rest.next);
  if (attrs.field !== '') {
    desc.attrs = str2CharArray(pvtHexUnescape(attrs.field), ',');
  }
  if (attrs.next === null) return { rc: LdapUrlErr.SUCCESS, desc };

  const scope = splitField(attrs.next);
  if (scope.field !== '') {
    desc.scope = pvtStr2Scope(pvtHexUnescape(scope.field));
    if (desc.scope === -1) return fail(LdapUrlErr.BADSCOPE);
  }
  if (scope.next === null) return { rc: LdapUrlErr.SUCCESS, desc };

  const filter = splitField(scope.next);
  if (filter.field !== '') {
    const unescaped = pvtHexUnescape(filter.field);
    if (unescaped === '') return fail(LdapUrlErr.BADFILTER);
    desc.filter = unescaped;
  }
  if (filter.next === null) return { rc: LdapUrlErr.SUCCESS, desc };

  if (filter.next.includes('?')) return fail(LdapUrlErr.BADURL);
  const exts = str2CharArray(filter.next, ',');
  if (exts.length === 0) return fail(LdapUrlErr.BADEXTS);
  desc.exts = exts.map(ext => pvtHexUnescape(ext));
  for (const ext of desc.exts) if (ext.startsWith('!')) desc.critExts++;
  return { rc: LdapUrlErr.SUCCESS, desc };
}

function splitField(text: string): { field: string; next: string | null } {
  const question = text.indexOf('?');
  if (question < 0) return { field: text, next: null };
  return { field: text.slice(0, question), next: text.slice(question + 1) };
}

function parsePort(portText: string, desc: LdapUrlDesc): number {
  const unescaped = pvtHexUnescape(portText);
  if (unescaped === '') return LdapUrlErr.BADURL;
  const parsed = cStrtol(unescaped);
  if (!parsed.consumed || parsed.rest !== '') return LdapUrlErr.BADURL;
  desc.port = parsed.value;
  return LdapUrlErr.SUCCESS;
}

export function ldapUrlParse(urlIn: string): LdapUrlParseResult {
  return ldapUrlParseExt(urlIn, LdapUrlParse.HISTORIC);
}

export interface LdapUrlListResult {
  rc: number;
  list: LdapUrlDesc[];
}

export function ldapUrlParseListExt(url: string, sep: string | null, flags: number, log?: LdapLog): LdapUrlListResult {
  const urls = str2CharArray(url, sep ?? ', ');
  const list: LdapUrlDesc[] = [];
  for (let i = urls.length - 1; i >= 0; i--) {
    const parsed = ldapUrlParseExt(urls[i], flags, log);
    if (parsed.rc !== LdapUrlErr.SUCCESS) return { rc: parsed.rc, list: [] };
    list.unshift(parsed.desc as LdapUrlDesc);
  }
  return { rc: LdapUrlErr.SUCCESS, list };
}

export function ldapUrlParseList(url: string): LdapUrlListResult {
  return ldapUrlParseListExt(url, ', ', LdapUrlParse.HISTORIC);
}

const URLESC_COMMA = 0x1;
const URLESC_SLASH = 0x2;

function hexEscape(text: string, list: number): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const c of text) {
    let escape = false;
    switch (c) {
      case '?': escape = true; break;
      case ',': escape = (list & URLESC_COMMA) !== 0; break;
      case '/': escape = (list & URLESC_SLASH) !== 0; break;
      case ';': case ':': case '@': case '&': case '=': case '+': case '$':
      case '-': case '_': case '.': case '!': case '~': case '*': case "'": case '(': case ')':
        break;
      default:
        escape = !/^[A-Za-z0-9]$/.test(c);
    }
    if (!escape) {
      out += c;
      continue;
    }
    for (const byte of encoder.encode(c)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function hexEscapeList(items: readonly string[], list: number): string {
  return items.map(item => hexEscape(item, list)).join(',');
}

export function ldapUrlDesc2Str(desc: LdapUrlDesc): string | null {
  const isIpc = desc.scheme === 'ldapi';
  const scope = pvtScope2Str(desc.scope);
  let sep = 0;
  if (desc.exts !== null) sep = 5;
  else if (desc.filter !== null) sep = 4;
  else if (scope !== null) sep = 3;
  else if (desc.attrs !== null) sep = 2;
  else if (desc.dn !== null && desc.dn !== '') sep = 1;

  if (desc.port > 65535) return null;
  const host = desc.host ?? '';
  const colon = host.indexOf(':');
  const isV6 = !isIpc && colon >= 0 && host.indexOf(':', colon + 1) >= 0;
  let out: string;
  if (desc.port !== 0) {
    out = `${desc.scheme}://${isV6 ? '[' : ''}${host}${isV6 ? ']' : ''}:${desc.port}`;
  } else {
    out = `${desc.scheme}://`;
    if (host !== '') out += `${isV6 ? '[' : ''}${hexEscape(host, URLESC_SLASH)}${isV6 ? ']' : ''}`;
  }
  if (sep < 1) return out;
  out += '/';
  if (desc.dn !== null && desc.dn !== '') out += hexEscape(desc.dn, 0);
  if (sep < 2) return out;
  out += '?';
  if (desc.attrs !== null) out += hexEscapeList(desc.attrs, 0);
  if (sep < 3) return out;
  out += '?';
  if (scope !== null) out += scope;
  if (sep < 4) return out;
  out += '?';
  if (desc.filter !== null) out += hexEscape(desc.filter, 0);
  if (sep < 5) return out;
  out += '?';
  if (desc.exts !== null) out += hexEscapeList(desc.exts, URLESC_COMMA);
  return out;
}

export function ldapUrlList2Urls(list: readonly LdapUrlDesc[]): string | null {
  if (list.length === 0) return null;
  const parts: string[] = [];
  for (const desc of list) {
    const text = ldapUrlDesc2Str(desc);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join(' ');
}

export function ldapUrlParseHosts(hosts: string, port: number): { rc: number; list: LdapUrlDesc[] } {
  const specs = str2CharArray(hosts, ', ');
  const list: LdapUrlDesc[] = [];
  for (const spec of specs) {
    const desc = emptyDesc('ldap', LdapScope.DEFAULT);
    desc.port = port;
    let host = spec;
    let p: string | null = null;
    const firstColon = host.indexOf(':');
    if (firstColon >= 0) {
      p = host.slice(firstColon);
      if (host.indexOf(':', firstColon + 1) >= 0) {
        if (host.startsWith('[')) {
          const close = host.indexOf(']', 1);
          if (close < 0) return { rc: LdapRc.PARAM_ERROR, list: [] };
          const tail = host.slice(close + 1);
          host = host.slice(1, close);
          if (!tail.startsWith(':')) {
            if (tail !== '') return { rc: LdapRc.PARAM_ERROR, list: [] };
            p = null;
          } else {
            p = tail;
          }
        } else {
          p = null;
        }
      } else {
        host = host.slice(0, firstColon);
      }
      if (p !== null) {
        const portText = pvtHexUnescape(p.slice(1));
        const parsed = cStrtol(portText);
        if (!parsed.consumed || parsed.rest !== '') return { rc: LdapRc.PARAM_ERROR, list: [] };
        desc.port = parsed.value;
      }
    }
    desc.host = pvtHexUnescape(host);
    list.push(desc);
  }
  return { rc: LdapRc.SUCCESS, list };
}

export function ldapUrlList2Hosts(list: readonly LdapUrlDesc[]): string | null {
  if (list.length === 0) return null;
  const parts: string[] = [];
  for (const desc of list) {
    if (desc.host === null) continue;
    let text = desc.host.includes(':') ? `[${desc.host}]` : desc.host;
    if (desc.port !== 0) text += `:${desc.port}`;
    parts.push(text);
  }
  return parts.join(' ');
}
