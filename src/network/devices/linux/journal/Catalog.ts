import { type JournalRecord, firstValue, parseId128 } from './JournalRecord';
import { text, utf8 } from './JournalText';
import { SYSTEMD_CATALOG_SOURCES } from './catalog/SystemdCatalogSources';

export interface CatalogItem {
  id: string;
  language: string;
  text: string;
}

export interface CatalogLocale {
  messages: string;
  utf8: boolean;
}

const COMMENTS = '#;';

function nextHeader(s: string, at: number): number | null {
  const e = s.indexOf('\n', at);
  if (e < 0) return null;
  if (e === at) return null;
  return e + 1;
}

function skipHeader(s: string): number {
  let at = 0;
  for (;;) {
    const next = nextHeader(s, at);
    if (next === null) return at;
    at = next;
  }
}

function combineEntries(one: string, two: string): string {
  const b1 = skipHeader(one);
  const b2 = skipHeader(two);
  const body = one.length - b1 > 0 ? one.slice(b1) : two.slice(b2);
  return one.slice(0, b1) + two.slice(0, b2) + body;
}

export function catalogFileLanguage(filename: string): string | null {
  if (!filename.endsWith('.catalog')) return null;
  const end = filename.length - '.catalog'.length;
  let beg = end - 1;
  while (beg > 0 && filename[beg] !== '.' && filename[beg] !== '/' && end - beg < 32) beg--;
  if (filename[beg] !== '.' || end <= beg + 1) return null;
  return filename.slice(beg + 1, end);
}

export function importCatalogFile(into: Map<string, CatalogItem>, path: string, content: string): void {
  const deflang = catalogFileLanguage(path);
  let gotId = false;
  let emptyLine = true;
  let id = '';
  let lang: string | null = null;
  let payload = '';
  const finish = (): void => {
    const language = lang ?? deflang ?? '';
    const key = `${id}\u0000${language}`;
    const previous = into.get(key);
    into.set(key, { id, language, text: previous ? combineEntries(payload, previous.text) : payload });
  };
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line === '') {
      emptyLine = true;
      continue;
    }
    if (COMMENTS.includes(line[0])) continue;
    if (emptyLine && line.length >= 2 + 1 + 32 && line.startsWith('-- ') && (line.length === 35 || line[35] === ' ')) {
      const withLanguage = line.length > 35;
      const parsed = parseId128(line.slice(3, 35));
      if (parsed !== null) {
        if (gotId) {
          finish();
          lang = null;
          payload = '';
        }
        if (withLanguage) {
          const requested = line.slice(36).trim();
          if (requested !== deflang) lang = requested;
        }
        gotId = true;
        emptyLine = false;
        id = parsed;
        continue;
      }
    }
    payload += `${emptyLine ? '\n' : ''}${line}\n`;
    emptyLine = false;
  }
  if (gotId) finish();
}

export function buildCatalog(sources: Readonly<Record<string, string>>): CatalogItem[] {
  const items = new Map<string, CatalogItem>();
  for (const name of Object.keys(sources).sort()) importCatalogFile(items, name, sources[name]);
  return [...items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.language < b.language ? -1 : a.language > b.language ? 1 : 0));
}

let cached: CatalogItem[] | null = null;

export function systemdCatalog(): CatalogItem[] {
  if (cached === null) cached = buildCatalog(SYSTEMD_CATALOG_SOURCES);
  return cached;
}

export function findCatalogText(items: readonly CatalogItem[], id: string, messagesLocale: string): string | null {
  const lookup = (language: string): CatalogItem | undefined => items.find(item => item.id === id && item.language === language);
  let found: CatalogItem | undefined;
  if (messagesLocale !== '' && messagesLocale !== 'C' && messagesLocale !== 'POSIX') {
    const length = messagesLocale.search(/[.@]/);
    const language = length < 0 ? messagesLocale : messagesLocale.slice(0, length);
    if (language.length <= 31) {
      found = lookup(language);
      if (found === undefined && language.includes('_')) found = lookup(language.slice(0, language.indexOf('_')));
    }
  }
  if (found === undefined) found = lookup('');
  return found === undefined ? null : found.text;
}

function substituteVariables(body: string, record: JournalRecord): string {
  let out = '';
  for (let i = 0; i < body.length;) {
    if (body[i] === '@') {
      const match = /^@([A-Z_]+)@/.exec(body.slice(i));
      if (match !== null) {
        const value = firstValue(record, match[1]);
        out += value === null || value.length > 4096 ? match[1] : text(value);
        i += match[0].length;
        continue;
      }
    }
    out += body[i++];
  }
  return out;
}

export function catalogForRecord(items: readonly CatalogItem[], record: JournalRecord, locale: CatalogLocale): string | null {
  const idField = firstValue(record, 'MESSAGE_ID');
  if (idField === null) return null;
  const id = parseId128(text(idField));
  if (id === null) return null;
  const body = findCatalogText(items, id, locale.messages);
  return body === null ? null : substituteVariables(body, record);
}

export function formatCatalogBlock(body: string, utf8Locale: boolean): Uint8Array {
  const prefix = utf8Locale ? '░░' : '--';
  const stripped = body.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
  return utf8(`${prefix} ${stripped.split('\n').join(`\n${prefix} `)}\n`);
}

function header(body: string, name: string): string | null {
  let at = 0;
  for (;;) {
    if (body.startsWith(name, at)) {
      const rest = body.slice(at + name.length).replace(/^[ \t\n\r]+/, '');
      const end = rest.search(/[\n\r]/);
      return end < 0 ? rest : rest.slice(0, end);
    }
    const next = nextHeader(body, at);
    if (next === null) return null;
    at = next;
  }
}

export function dumpCatalogEntry(id: string, body: string, oneline: boolean): string {
  if (oneline) return `${id} ${header(body, 'Defined-By:') ?? '(null)'}: ${header(body, 'Subject:') ?? '(null)'}\n`;
  return `-- ${id}\n${body}\n`;
}

export function listCatalog(items: readonly CatalogItem[], locale: CatalogLocale, oneline: boolean): string {
  let out = '';
  let last: string | null = null;
  for (const item of items) {
    if (item.id === last) continue;
    last = item.id;
    out += dumpCatalogEntry(item.id, findCatalogText(items, item.id, locale.messages) as string, oneline);
  }
  return out;
}
