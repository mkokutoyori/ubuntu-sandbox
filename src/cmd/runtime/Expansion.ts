export interface FileFacts {
  readonly isDirectory: boolean;
  readonly size: number;
  readonly written: Date;
  readonly attributes: ReadonlySet<string>;
}

export interface ExpansionContext {
  readonly batch: boolean;
  readonly arguments: readonly string[];
  readonly scriptPath: string | null;
  lookup(name: string): string | undefined;
  absolute(path: string): string;
  factsOf(absolutePath: string): FileFacts | null;
}

const NAME_BODY = /^[^%!\s:~^]+$/;

function substitute(value: string, search: string, replacement: string): string {
  if (search === '') return value;
  if (search.startsWith('*')) {
    const tail = search.slice(1);
    const index = value.toLowerCase().indexOf(tail.toLowerCase());
    return index < 0 ? value : replacement + value.slice(index + tail.length);
  }
  const lowered = value.toLowerCase();
  const needle = search.toLowerCase();
  let result = '';
  let cursor = 0;
  for (;;) {
    const index = lowered.indexOf(needle, cursor);
    if (index < 0) return result + value.slice(cursor);
    result += value.slice(cursor, index) + replacement;
    cursor = index + needle.length;
  }
}

function slice(value: string, offsetText: string, lengthText: string | undefined): string {
  const offsetRaw = Number.parseInt(offsetText, 10);
  if (Number.isNaN(offsetRaw)) return value;
  const start = offsetRaw < 0 ? Math.max(0, value.length + offsetRaw) : Math.min(offsetRaw, value.length);
  if (lengthText === undefined || lengthText === '') return value.slice(start);
  const length = Number.parseInt(lengthText, 10);
  if (Number.isNaN(length)) return value.slice(start);
  return length < 0 ? value.slice(start, Math.max(start, value.length + length)) : value.slice(start, start + length);
}

function applyVariableForm(value: string, form: string): string | null {
  if (form.startsWith('~')) {
    const [offset, length] = form.slice(1).split(',');
    return slice(value, offset, length);
  }
  const equals = form.indexOf('=');
  if (equals < 0) return null;
  return substitute(value, form.slice(0, equals), form.slice(equals + 1));
}

function expandVariableBody(body: string, lookup: (name: string) => string | undefined): string | undefined {
  const colon = body.indexOf(':');
  const name = colon < 0 ? body : body.slice(0, colon);
  if (!NAME_BODY.test(name)) return undefined;
  const value = lookup(name);
  if (value === undefined) return colon < 0 ? undefined : '';
  if (colon < 0) return value;
  return applyVariableForm(value, body.slice(colon + 1)) ?? undefined;
}

function formatWritten(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = date.getHours();
  const hour12 = String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day}/${date.getFullYear()}  ${hour12}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
}

function attributeLetters(facts: FileFacts): string {
  const has = (name: string): boolean => facts.attributes.has(name);
  return [
    facts.isDirectory ? 'd' : '-', has('readonly') ? 'r' : '-', has('archive') ? 'a' : '-',
    has('hidden') ? 'h' : '-', has('system') ? 's' : '-', '-', '-', '-', '-',
  ].join('');
}

function splitPath(absolute: string): { drive: string; directory: string; name: string; extension: string } {
  const drive = /^[A-Za-z]:/.test(absolute) ? absolute.slice(0, 2) : '';
  const rest = absolute.slice(drive.length);
  const lastSeparator = rest.lastIndexOf('\\');
  const directory = lastSeparator < 0 ? '' : rest.slice(0, lastSeparator + 1);
  const leaf = lastSeparator < 0 ? rest : rest.slice(lastSeparator + 1);
  const dot = leaf.lastIndexOf('.');
  return dot <= 0
    ? { drive, directory, name: leaf, extension: '' }
    : { drive, directory, name: leaf.slice(0, dot), extension: leaf.slice(dot) };
}

export function applyPathModifiers(modifiers: string, value: string, context: ExpansionContext): string {
  const unquoted = value.replace(/^"(.*)"$/s, '$1');
  const wanted = new Set(modifiers.toLowerCase());
  if (wanted.size === 0) return unquoted;
  const absolute = context.absolute(unquoted);
  const facts = context.factsOf(absolute);
  const parts = splitPath(absolute);
  const pieces: string[] = [];
  if (wanted.has('f')) pieces.push(absolute);
  else {
    if (wanted.has('d')) pieces.push(parts.drive);
    if (wanted.has('p')) pieces.push(parts.directory);
    if (wanted.has('n')) pieces.push(parts.name);
    if (wanted.has('x')) pieces.push(parts.extension);
  }
  const fileInformation: string[] = [];
  if (wanted.has('a') && facts) fileInformation.push(attributeLetters(facts));
  if (wanted.has('t') && facts) fileInformation.push(formatWritten(facts.written));
  if (wanted.has('z') && facts) fileInformation.push(String(facts.size));
  return [pieces.join(''), ...fileInformation].filter(piece => piece !== '').join(' ');
}

const MODIFIER_LETTERS = 'fdpnxsatz';

function argumentValue(index: number, context: ExpansionContext): string {
  return index === 0 ? context.scriptPath ?? '' : context.arguments[index - 1] ?? '';
}

export function expandPercent(text: string, context: ExpansionContext): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character !== '%') { result += character; index++; continue; }

    if (text[index + 1] === '%') {
      result += context.batch ? '%' : '%%';
      index += 2;
      continue;
    }
    if (context.batch && text[index + 1] === '*') {
      result += context.arguments.join(' ');
      index += 2;
      continue;
    }
    if (context.batch && /\d/.test(text[index + 1] ?? '')) {
      result += argumentValue(Number(text[index + 1]), context);
      index += 2;
      continue;
    }
    if (context.batch && text[index + 1] === '~') {
      let cursor = index + 2;
      let modifiers = '';
      while (cursor < text.length && MODIFIER_LETTERS.includes(text[cursor].toLowerCase())) { modifiers += text[cursor]; cursor++; }
      if (/\d/.test(text[cursor] ?? '')) {
        result += applyPathModifiers(modifiers, argumentValue(Number(text[cursor]), context), context);
        index = cursor + 1;
        continue;
      }
    }

    const close = text.indexOf('%', index + 1);
    if (close < 0) { result += text.slice(index); break; }
    const expanded = expandVariableBody(text.slice(index + 1, close), context.lookup);
    if (expanded === undefined) {
      if (context.batch && NAME_BODY.test(text.slice(index + 1, close).split(':')[0])) {
        index = close + 1;
        continue;
      }
      result += '%';
      index++;
      continue;
    }
    result += expanded;
    index = close + 1;
  }
  return result;
}

export function expandDelayed(text: string, lookup: (name: string) => string | undefined): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '^' && text[index + 1] === '!') { result += '!'; index += 2; continue; }
    if (character !== '!') { result += character; index++; continue; }
    const close = text.indexOf('!', index + 1);
    if (close < 0) { result += text.slice(index + 1); break; }
    const expanded = expandVariableBody(text.slice(index + 1, close), lookup);
    result += expanded ?? '';
    index = close + 1;
  }
  return result;
}

export function substituteLoopVariables(
  text: string, bindings: ReadonlyMap<string, string>, context: ExpansionContext,
): string {
  if (bindings.size === 0) return text;
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '%') { result += text[index]; index++; continue; }
    if (text[index + 1] === '~') {
      let cursor = index + 2;
      let run = '';
      while (cursor < text.length && MODIFIER_LETTERS.includes(text[cursor].toLowerCase())) { run += text[cursor]; cursor++; }
      if (cursor < text.length && bindings.has(text[cursor])) {
        result += applyPathModifiers(run, bindings.get(text[cursor])!, context);
        index = cursor + 1;
        continue;
      }
      const last = run[run.length - 1];
      if (last !== undefined && bindings.has(last)) {
        result += applyPathModifiers(run.slice(0, -1), bindings.get(last)!, context);
        index = cursor;
        continue;
      }
    }
    const name = text[index + 1];
    if (name !== undefined && bindings.has(name)) {
      result += bindings.get(name)!;
      index += 2;
      continue;
    }
    result += '%';
    index++;
  }
  return result;
}
