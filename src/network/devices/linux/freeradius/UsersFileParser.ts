import { RADIUS_ATTR, type RadiusAttribute, type RadiusAttrType } from '@/network/radius/types';
import { isKnownGoodName, type KnownGoodItem } from '@/network/radius/KnownGoodPassword';
import { RADIUS_DICTIONARY, RADIUS_VALUE_NAMES, type RadiusValueType } from '@/network/radius/dictionary';

export type UsersOperator = '=' | ':=' | '+=' | '-=' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '=~' | '!~';

export interface UsersPair {
  name: string;
  op: UsersOperator;
  value: string;
  tag: number | null;
}

export interface UsersEntry {
  name: string;
  check: UsersPair[];
  reply: UsersPair[];
  line: number;
}

export type ParsedUsers = { ok: true; entries: UsersEntry[] } | { ok: false; error: string };

export type UsersRequestView = (attributeName: string, wanted?: string) => string | number | undefined;

export function requestViewOf(
  attributes: readonly RadiusAttribute[], overlay: ReadonlyMap<string, string>, groupsOf: (username: string) => readonly string[], username: string,
): UsersRequestView {
  return (name, wanted) => {
    if (name === 'group') return wanted !== undefined && groupsOf(username).includes(wanted) ? wanted : '';
    return overlay.get(name) ?? attributes.find((candidate) => candidate.type === name)?.value;
  };
}

export interface UsersMatch {
  password: string | null;
  knownGood: KnownGoodItem[];
  acceptAny: boolean;
  rejected: boolean;
  loginTime: string | null;
  simultaneousUse: number | null;
  reply: RadiusAttribute[];
}

const OPERATORS: UsersOperator[] = ['=~', '!~', ':=', '+=', '-=', '==', '!=', '<=', '>=', '=', '<', '>'];

export type PairListResult = { ok: true; pairs: UsersPair[]; trailingComma: boolean } | { ok: false; error: string };

function scanValue(text: string, at: number): { value: string; end: number } | null {
  const quote = text[at];
  if (quote === '"' || quote === "'" || quote === '`') {
    let out = '';
    let i = at + 1;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        i += 2;
        continue;
      }
      out += text[i];
      i++;
    }
    if (i >= text.length) return null;
    return { value: out, end: i + 1 };
  }
  let i = at;
  while (i < text.length && !/[\s,]/.test(text[i])) i++;
  return { value: text.slice(at, i), end: i };
}

export function parsePairList(text: string): PairListResult {
  const pairs: UsersPair[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length || text[i] === '#') return { ok: true, pairs, trailingComma: false };
    let nameEnd = i;
    while (nameEnd < text.length && /[A-Za-z0-9_.:\-/]/.test(text[nameEnd])) nameEnd++;
    if (nameEnd === i) return { ok: false, error: `Unexpected character '${text[i]}'` };
    let name = text.slice(i, nameEnd);
    let tag: number | null = null;
    const tagged = /^(.*):(\d+)$/.exec(name);
    if (tagged) { name = tagged[1]; tag = Number(tagged[2]); }
    i = nameEnd;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (!op) return { ok: false, error: `Expected comparison operator after attribute '${name}'` };
    i += op.length;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    const scanned = scanValue(text, i);
    if (!scanned) return { ok: false, error: `Unterminated string for attribute '${name}'` };
    pairs.push({ name, op, value: scanned.value, tag });
    i = scanned.end;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    if (i >= text.length || text[i] === '\n' || text[i] === '#') return { ok: true, pairs, trailingComma: false };
    if (text[i] === ',') {
      i++;
      while (i < text.length && /[ \t]/.test(text[i])) i++;
      if (i >= text.length || text[i] === '\n' || text[i] === '#') return { ok: true, pairs, trailingComma: true };
      continue;
    }
    return { ok: false, error: `Unexpected text after value of attribute '${name}'` };
  }
}

const CONTROL_ONLY = new Set(['cleartext-password', 'crypt-password', 'md5-password', 'smd5-password', 'sha-password', 'ssha-password', 'nt-password', 'sha2-password', 'password-with-header', 'auth-type', 'fall-through', 'hint', 'huntgroup-name', 'user-category', 'group', 'simultaneous-use', 'login-time', 'strip-user-name']);

const FILE_ONLY_NAMES = new Set(['suffix', 'strip-user-name', 'realm']);

function knownName(name: string): boolean {
  const key = name.toLowerCase();
  return key in RADIUS_ATTR || CONTROL_ONLY.has(key) || FILE_ONLY_NAMES.has(key);
}

export function parseUsersFile(source: string, fileName: string, readFile: (path: string) => string | null): ParsedUsers {
  const entries: UsersEntry[] = [];
  const fail = (line: number, message: string): ParsedUsers => ({ ok: false, error: `${fileName}[${line}]: ${message}` });
  return readEntries(source, fileName, readFile, entries, fail);
}

function readEntries(
  source: string, fileName: string, readFile: (path: string) => string | null,
  entries: UsersEntry[], fail: (line: number, message: string) => ParsedUsers,
): ParsedUsers {
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let mode: 'name' | 'want-reply' | 'have-reply' = 'name';
  let name = '';
  let entryLine = 0;
  let check: UsersPair[] = [];
  let reply: UsersPair[] = [];
  const finish = (): void => {
    entries.push({ name, check, reply, line: entryLine });
    check = [];
    reply = [];
    mode = 'name';
  };
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const buffer = lines[index];
    const trimmed = buffer.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    for (;;) {
      if (mode === 'name') {
        if (/^\s/.test(buffer)) return fail(lineNo, 'Entry does not begin with a user name');
        const match = /^(\S+)\s*(.*)$/.exec(buffer);
        name = match![1];
        const rest = match![2];
        entryLine = lineNo;
        if (name.toLowerCase() === '$include') {
          const target = rest.trim().split(/\s+/)[0] ?? '';
          const path = target.startsWith('/') ? target : `${fileName.slice(0, fileName.lastIndexOf('/') + 1)}${target}`;
          const included = readFile(path);
          if (included === null) return fail(lineNo, `Could not open included file ${path}: No such file or directory`);
          const nested = parseUsersFile(included, path, readFile);
          if ('error' in nested) return nested;
          entries.push(...nested.entries);
          break;
        }
        const parsed = parsePairList(rest);
        if ('error' in parsed) return fail(lineNo, `Parse error (check) for entry ${name}: ${parsed.error}`);
        if (parsed.trailingComma) return fail(lineNo, `Invalid text after check attributes for entry ${name}`);
        for (const pair of parsed.pairs) {
          if (!knownName(pair.name)) return fail(lineNo, `Parse error (check) for entry ${name}: Unknown attribute "${pair.name}"`);
        }
        check = parsed.pairs;
        mode = 'want-reply';
        break;
      }
      if (mode === 'want-reply') {
        if (!/^\s/.test(buffer)) { finish(); continue; }
        mode = 'have-reply';
      }
      if (!/^\s/.test(buffer)) return fail(lineNo, 'Invalid comma after the reply attributes.  Please delete it.');
      const parsed = parsePairList(buffer);
      if ('error' in parsed) return fail(lineNo, `Parse error (reply) for entry ${name}: ${parsed.error}`);
      for (const pair of parsed.pairs) {
        if (!knownName(pair.name)) return fail(lineNo, `Parse error (reply) for entry ${name}: Unknown attribute "${pair.name}"`);
        if (pair.name.toLowerCase() in RADIUS_ATTR && usersPairToAttribute(pair) === null) {
          return fail(lineNo, `Parse error (reply) for entry ${name}: Failed parsing "${pair.value}" as a value for attribute "${pair.name}"`);
        }
      }
      reply.push(...parsed.pairs);
      if (!parsed.trailingComma) finish();
      break;
    }
  }
  if (mode === 'have-reply') return fail(lines.length, 'Invalid comma after the reply attributes.  Please delete it.');
  if (mode === 'want-reply') finish();
  return { ok: true, entries };
}

function encodeValue(valueType: RadiusValueType, type: RadiusAttrType, raw: string): string | number | null {
  if (valueType === 'integer' || valueType === 'tagged-integer' || valueType === 'time') {
    const named = RADIUS_VALUE_NAMES[type]?.[raw.toLowerCase()];
    if (named !== undefined) return named;
    return /^\d+$/.test(raw) ? Number(raw) : null;
  }
  return raw;
}

export function usersPairToAttribute(pair: UsersPair): RadiusAttribute | null {
  const key = pair.name.toLowerCase();
  if (!(key in RADIUS_ATTR)) return null;
  const type = key as RadiusAttrType;
  const value = encodeValue(RADIUS_DICTIONARY[type].valueType, type, pair.value);
  return value === null ? null : { type, value };
}

function matches(op: UsersOperator, actual: string | number | undefined, wanted: string): boolean {
  if (actual === undefined) return op === '!=' || op === '!~';
  const left = String(actual);
  switch (op) {
    case '==': case '=': return left === wanted;
    case '!=': return left !== wanted;
    case '<': return Number(left) < Number(wanted);
    case '>': return Number(left) > Number(wanted);
    case '<=': return Number(left) <= Number(wanted);
    case '>=': return Number(left) >= Number(wanted);
    case '=~': return new RegExp(wanted).test(left);
    case '!~': return !new RegExp(wanted).test(left);
    default: return true;
  }
}

const SETTING_OPS = new Set<UsersOperator>([':=', '+=', '-=']);

export function isSettingPair(pair: UsersPair): boolean {
  return SETTING_OPS.has(pair.op) || (pair.op === '=' && CONTROL_ONLY.has(pair.name.toLowerCase()));
}

export function pairMatches(pair: UsersPair, username: string, request: UsersRequestView): boolean {
  const key = pair.name.toLowerCase();
  const wanted = String(usersPairToAttribute(pair)?.value ?? pair.value);
  const actual = key === 'user-name' ? username : request(key, wanted);
  return matches(pair.op, actual, wanted);
}

export function matchUsersEntries(entries: UsersEntry[], username: string, request: UsersRequestView): UsersMatch | null {
  const result: UsersMatch = { password: null, knownGood: [], acceptAny: false, rejected: false, loginTime: null, simultaneousUse: null, reply: [] };
  let matched = false;
  for (const entry of entries) {
    if (entry.name !== 'DEFAULT' && entry.name !== username) continue;
    const control: Array<[string, string]> = [];
    let selected = true;
    for (const pair of entry.check) {
      const key = pair.name.toLowerCase();
      if (isSettingPair(pair)) {
        control.push([key, pair.value]);
        continue;
      }
      if (!pairMatches(pair, username, request)) { selected = false; break; }
    }
    if (!selected) continue;
    matched = true;
    for (const [key, value] of control) {
      if (isKnownGoodName(key)) result.knownGood = [...result.knownGood.filter((item) => item.name !== key), { name: key, value }];
      if (key === 'cleartext-password') result.password = value;
      else if (key === 'auth-type' && value.toLowerCase() === 'accept') result.acceptAny = true;
      else if (key === 'auth-type' && value.toLowerCase() === 'reject') result.rejected = true;
      else if (key === 'login-time') result.loginTime = value;
      else if (key === 'simultaneous-use') result.simultaneousUse = Number(value);
    }
    let fallThrough = false;
    for (const pair of entry.reply) {
      if (pair.name.toLowerCase() === 'fall-through') { fallThrough = /^(yes|1)$/i.test(pair.value); continue; }
      const attribute = usersPairToAttribute(pair);
      if (attribute) result.reply.push(attribute);
    }
    if (!fallThrough) break;
  }
  return matched ? result : null;
}
