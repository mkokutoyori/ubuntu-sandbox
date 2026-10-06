import { LdapDebug, type LdapLog } from './ldapLog';
import { ldapErr2String } from './ldapErrors';

export type AvaEncoding = 'string' | 'binary' | 'nonprintable';

export interface Ava {
  readonly attribute: string;
  readonly value: Uint8Array;
  readonly encoding: AvaEncoding;
}

export type Rdn = readonly Ava[];
export type Dn = readonly Rdn[];

const SPACES = new Set([0x20, 0x09, 0x0a, 0x0d]);

const ESCAPE = 0x5c;
const QUOTE = 0x22;
const EQUALS = 0x3d;
const PLUS = 0x2b;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const OCTOTHORPE = 0x23;
const LESS = 0x3c;
const GREATER = 0x3e;

function isSpace(byte: number | undefined): boolean {
  return byte !== undefined && SPACES.has(byte);
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isAlpha(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isLdh(byte: number): boolean {
  return isAlpha(byte) || isDigit(byte) || byte === 0x2d;
}

function isHex(byte: number | undefined): boolean {
  return byte !== undefined && (isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));
}

function hexValue(byte: number): number {
  if (isDigit(byte)) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return byte - 0x61 + 10;
}

function isValueEndV2(byte: number): boolean {
  return byte === COMMA || byte === SEMICOLON || byte === PLUS;
}

function isNe(byte: number): boolean {
  return byte === COMMA || byte === SEMICOLON || byte === PLUS || byte === QUOTE || byte === LESS || byte === GREATER;
}

function isMayEscape(byte: number): boolean {
  return byte === ESCAPE || isNe(byte) || byte === EQUALS || isSpace(byte) || byte === OCTOTHORPE;
}

function needEscape(byte: number): boolean {
  return byte === ESCAPE || isNe(byte);
}

function needEscapeTrail(byte: number): boolean {
  return isSpace(byte) || needEscape(byte);
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

interface Cursor { at: number }

function parseValueV3(text: Uint8Array, cursor: Cursor): { value: Uint8Array; encoding: AvaEncoding } | null {
  const start = cursor.at;
  let p = start;
  let encoding: AvaEncoding = 'string';
  while (p < text.length) {
    const byte = text[p];
    if (byte === ESCAPE) {
      p++;
      if (p >= text.length) return null;
      if (isMayEscape(text[p])) { p++; continue; }
      if (isHex(text[p]) && isHex(text[p + 1])) {
        const decoded = hexValue(text[p]) * 16 + hexValue(text[p + 1]);
        if (!isPrintable(decoded)) encoding = 'nonprintable';
        p += 2;
        continue;
      }
      return null;
    }
    if (!isPrintable(byte)) {
      if (byte === 0) return null;
      encoding = 'nonprintable';
    } else if (isValueEndV2(byte)) {
      break;
    } else if (needEscape(byte)) {
      return null;
    }
    p++;
  }
  let end = p;
  if (p > start + 1 && isSpace(text[p - 1]) && text[p - 2] !== ESCAPE) {
    for (end = p - 1; end > start + 1 && isSpace(text[end - 1]) && text[end - 2] !== ESCAPE; end--) { /* trim */ }
  }
  const raw = text.slice(start, end);
  const out: number[] = [];
  for (let s = 0; s < raw.length;) {
    if (raw[s] === ESCAPE) {
      s++;
      if (isMayEscape(raw[s])) { out.push(raw[s++]); continue; }
      out.push(hexValue(raw[s]) * 16 + hexValue(raw[s + 1]));
      s += 2;
      continue;
    }
    out.push(raw[s++]);
  }
  cursor.at = p;
  return { value: Uint8Array.from(out), encoding };
}

function parseQuoted(text: Uint8Array, cursor: Cursor): Uint8Array | null {
  const out: number[] = [];
  let p = cursor.at;
  for (; p < text.length; p++) {
    if (text[p] === ESCAPE) {
      if (p + 1 >= text.length) return null;
      p++;
      out.push(text[p]);
    } else if (text[p] === QUOTE) {
      p++;
      while (isSpace(text[p])) p++;
      if (p < text.length && !isValueEndV2(text[p])) return null;
      cursor.at = p;
      return Uint8Array.from(out);
    } else {
      out.push(text[p]);
    }
  }
  return null;
}

function parseHexBinary(text: Uint8Array, cursor: Cursor): Uint8Array | null {
  const out: number[] = [];
  let p = cursor.at;
  for (; p < text.length; p += 2) {
    if (isValueEndV2(text[p])) break;
    if (isSpace(text[p])) {
      while (p < text.length && isSpace(text[p])) p++;
      if (p < text.length && !isValueEndV2(text[p])) return null;
      break;
    }
    if (!isHex(text[p]) || !isHex(text[p + 1])) return null;
    out.push(hexValue(text[p]) * 16 + hexValue(text[p + 1]));
  }
  cursor.at = p;
  return Uint8Array.from(out);
}

function parseAttributeType(text: Uint8Array, cursor: Cursor): string | null {
  const start = cursor.at;
  let p = start;
  if (isDigit(text[p])) {
    let dot = false;
    for (; p < text.length; p++) {
      if (isDigit(text[p])) { dot = false; continue; }
      if (text[p] === 0x2e) { if (dot) return null; dot = true; continue; }
      break;
    }
    if (dot) return null;
    cursor.at = p;
    return String.fromCharCode(...text.slice(start, p));
  }
  if (!isAlpha(text[p])) return null;
  p++;
  while (p < text.length && isLdh(text[p])) p++;
  let end = p;
  if (text[p] === SEMICOLON) {
    end = p;
    while (p < text.length && (isLdh(text[p]) || text[p] === SEMICOLON)) p++;
  }
  cursor.at = p;
  return end === start ? null : String.fromCharCode(...text.slice(start, end));
}

function skipSpaces(text: Uint8Array, cursor: Cursor): void {
  while (cursor.at < text.length && isSpace(text[cursor.at])) cursor.at++;
}

function parseRdn(text: Uint8Array, cursor: Cursor): Rdn | null {
  const avas: Ava[] = [];
  for (;;) {
    skipSpaces(text, cursor);
    if (cursor.at >= text.length) return null;
    const attribute = parseAttributeType(text, cursor);
    if (attribute === null) return null;
    skipSpaces(text, cursor);
    if (text[cursor.at] !== EQUALS) return null;
    cursor.at++;
    skipSpaces(text, cursor);
    let value: Uint8Array;
    let encoding: AvaEncoding = 'string';
    if (text[cursor.at] === OCTOTHORPE) {
      cursor.at++;
      const decoded = parseHexBinary(text, cursor);
      if (decoded === null) return null;
      value = decoded;
      encoding = 'binary';
    } else if (text[cursor.at] === QUOTE) {
      cursor.at++;
      const quoted = parseQuoted(text, cursor);
      if (quoted === null) return null;
      value = quoted;
    } else if (cursor.at >= text.length) {
      value = new Uint8Array(0);
    } else {
      const plain = parseValueV3(text, cursor);
      if (plain === null) return null;
      value = plain.value;
      encoding = plain.encoding;
    }
    avas.push({ attribute, value, encoding });
    if (text[cursor.at] !== PLUS) return avas;
    cursor.at++;
  }
}

export function parseDn(dn: string): Dn | null {
  const text = new TextEncoder().encode(dn);
  if (text.length === 0) return [];
  if (text.includes(0)) return null;
  const rdns: Rdn[] = [];
  const cursor: Cursor = { at: 0 };
  while (cursor.at < text.length) {
    const rdn = parseRdn(text, cursor);
    if (rdn === null) return null;
    if (cursor.at < text.length && text[cursor.at] !== COMMA && text[cursor.at] !== SEMICOLON) return null;
    rdns.push(rdn);
    if (cursor.at >= text.length) break;
    cursor.at++;
  }
  return rdns;
}

function utf8CharLength(first: number): number {
  if (first < 0x80) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return 0;
}

function hexPair(byte: number): string {
  return `\\${'0123456789ABCDEF'[(byte >> 4) & 0x0f]}${'0123456789ABCDEF'[byte & 0x0f]}`;
}

function valueToUfnString(value: Uint8Array): string | null {
  const last = value.length - 1;
  let out = '';
  for (let s = 0; s < value.length;) {
    const byte = value[s];
    if (byte === 0) { out += '\\00'; s++; continue; }
    const charLength = utf8CharLength(byte);
    if (charLength === 0) return null;
    if (charLength > 1) {
      for (let k = 1; k < charLength; k++) {
        if (s + k >= value.length || (value[s + k] & 0xc0) !== 0x80) return null;
      }
      for (let k = 0; k < charLength; k++) out += hexPair(value[s + k]);
      s += charLength;
      continue;
    }
    if (needEscape(byte) || byte === EQUALS || (s === 0 && isMayEscape(byte)) || (s === last && needEscapeTrail(byte))) {
      out += hexPair(byte);
    } else {
      out += String.fromCharCode(byte);
    }
    s++;
  }
  return out;
}

function rdnToUfn(rdn: Rdn): string | null {
  const parts: string[] = [];
  for (const ava of rdn) {
    if (ava.encoding === 'binary') {
      parts.push(`#${Array.from(ava.value, byte => hexPair(byte).slice(1)).join('')}`);
      continue;
    }
    const text = valueToUfnString(ava.value);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join(' + ');
}

function isDomainComponent(rdn: Rdn): boolean {
  return rdn.length === 1 && rdn[0].encoding === 'string' && rdn[0].attribute.toLowerCase() === 'dc';
}

function isPrintableValue(value: Uint8Array): boolean {
  if (value.length === 0) return false;
  const first = value[0];
  const last = value[value.length - 1];
  const graph = (b: number): boolean => b > 0x20 && b < 0x7f;
  if (!graph(first) || first === 0x3a || first === LESS || !graph(last)) return false;
  return Array.from(value).every(byte => isPrintable(byte));
}


const LDAP_DN_FORMAT_LDAP = 0;
const LDAP_DN_FORMAT_UFN = 64;
const LDAP_DECODING_ERROR = -4;

function str2dn(dn: string, log: LdapLog | undefined): Dn | null {
  log?.debug(LdapDebug.ARGS, `=> ldap_bv2dn(${dn},${LDAP_DN_FORMAT_LDAP})\n`);
  const parsed = parseDn(dn);
  const rc = parsed === null ? LDAP_DECODING_ERROR : 0;
  if (rc !== 0) log?.debug(LdapDebug.TRACE, 'ldap_err2string\n');
  log?.debug(LdapDebug.ARGS, `<= ldap_bv2dn(${dn})=${rc} ${rc !== 0 ? ldapErr2String(rc) : ''}\n`);
  return parsed;
}

function dn2bvTrace(text: string | null, log: LdapLog | undefined): void {
  log?.debug(LdapDebug.ARGS, `=> ldap_dn2bv(${LDAP_DN_FORMAT_UFN})\n`);
  const rc = text === null ? LDAP_DECODING_ERROR : 0;
  if (rc !== 0) log?.debug(LdapDebug.TRACE, 'ldap_err2string\n');
  log?.debug(LdapDebug.ARGS, `<= ldap_dn2bv(${text ?? ''})=${rc} ${rc !== 0 ? ldapErr2String(rc) : ''}\n`);
}

export function dnToUfn(dn: string, log?: LdapLog): string | null {
  log?.debug(LdapDebug.TRACE, 'ldap_dn2ufn\n');
  log?.debug(LdapDebug.TRACE, 'ldap_dn_normalize\n');
  const parsed = str2dn(dn, log);
  if (parsed === null) return null;
  const out = ufnOf(parsed);
  dn2bvTrace(out, log);
  return out;
}

function ufnOf(parsed: Dn): string | null {
  if (parsed.length === 0) return '';
  let leftmostDc = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (isDomainComponent(parsed[i])) { if (leftmostDc === -1) leftmostDc = i; } else { leftmostDc = -1; }
  }
  const parts: string[] = [];
  const limit = leftmostDc === -1 ? parsed.length : leftmostDc;
  for (let i = 0; i < limit; i++) {
    const text = rdnToUfn(parsed[i]);
    if (text === null) return null;
    parts.push(text);
  }
  if (leftmostDc !== -1) {
    const labels: string[] = [];
    for (let i = parsed.length - 1; i >= leftmostDc; i--) {
      const value = parsed[i][0].value;
      if (!isPrintableValue(value)) return null;
      labels.unshift(new TextDecoder().decode(value));
    }
    parts.push(labels.join('.'));
  }
  return parts.join(', ');
}

export function dnToDomain(dn: string, log?: LdapLog): string | null {
  const parsed = str2dn(dn, log);
  if (parsed === null || parsed.length === 0) return null;
  const labels: string[] = [];
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (!isDomainComponent(parsed[i])) break;
    const value = parsed[i][0].value;
    if (!isPrintableValue(value)) return null;
    labels.unshift(new TextDecoder().decode(value));
  }
  return labels.length === 0 ? null : labels.join('.');
}

export function explodeDnWithoutTypes(dn: string, log?: LdapLog): string[] | null {
  log?.debug(LdapDebug.TRACE, 'ldap_explode_dn\n');
  const parsed = str2dn(dn, log);
  if (parsed === null) return null;
  const out: string[] = [];
  for (const rdn of parsed) {
    const text = rdnToUfn(rdn);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}
