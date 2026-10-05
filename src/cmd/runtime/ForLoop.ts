import { wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import type { BatchHost } from '../BatchHost';
import type { ForMode } from '../parser/StatementParser';

export interface ForSource {
  readonly mode: ForMode;
  readonly root: string | null;
  readonly options: string | null;
  readonly variable: string;
  readonly set: string;
}

export interface ForIterations {
  readonly bindings: Array<Map<string, string>>;
  readonly messages: string[];
}

interface FileOptions {
  eol: string;
  skip: number;
  delims: string;
  tokens: Array<number | 'rest'>;
  usebackq: boolean;
}

const hasWildcard = (text: string): boolean => /[*?]/.test(text);
const joinPath = (directory: string, name: string): string =>
  directory.endsWith('\\') ? `${directory}${name}` : `${directory}\\${name}`;

export function splitSetItems(set: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote = false;
  for (const character of set) {
    if (character === '"') inQuote = !inQuote;
    if (!inQuote && (character === ' ' || character === '\t' || character === ',' || character === ';' || character === '\n')) {
      if (current !== '') items.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current !== '') items.push(current);
  return items;
}

function patternMatcher(pattern: string): (name: string) => boolean {
  if (pattern === '*' || pattern === '*.*') return () => true;
  const expression = wildcardToRegex(pattern);
  return name => expression.test(name);
}

function expandWildcard(host: BatchHost, item: string, wantDirectories: boolean): string[] {
  const unquoted = item.replace(/^"(.*)"$/, '$1');
  const separator = unquoted.lastIndexOf('\\');
  const prefix = separator < 0 ? '' : unquoted.slice(0, separator + 1);
  const pattern = separator < 0 ? unquoted : unquoted.slice(separator + 1);
  const directory = host.fs.normalize(prefix === '' ? host.cwd() : prefix, host.cwd());
  const matches = patternMatcher(pattern);
  return host.fs.list(directory)
    .filter(entry => entry.isDirectory === wantDirectories && matches(entry.name))
    .map(entry => `${prefix}${entry.name}`);
}

function walkDirectories(host: BatchHost, root: string): string[] {
  const found = [root];
  for (const entry of host.fs.list(root)) {
    if (entry.isDirectory) found.push(...walkDirectories(host, joinPath(root, entry.name)));
  }
  return found;
}

function plainValues(host: BatchHost, items: readonly string[], wantDirectories: boolean): string[] {
  const values: string[] = [];
  for (const item of items) {
    if (hasWildcard(item)) values.push(...expandWildcard(host, item, wantDirectories));
    else if (!wantDirectories) values.push(item);
    else if (host.fs.isDirectory(host.fs.normalize(item.replace(/^"(.*)"$/, '$1'), host.cwd()))) values.push(item);
  }
  return values;
}

function recursiveValues(host: BatchHost, root: string, items: readonly string[]): string[] {
  const values: string[] = [];
  for (const directory of walkDirectories(host, root)) {
    for (const item of items) {
      if (item === '.') values.push(joinPath(directory, '.'));
      else if (hasWildcard(item)) {
        const matches = patternMatcher(item);
        for (const entry of host.fs.list(directory)) {
          if (!entry.isDirectory && matches(entry.name)) values.push(joinPath(directory, entry.name));
        }
      } else values.push(joinPath(directory, item));
    }
  }
  return values;
}

function rangeValues(set: string): string[] {
  const [start, step, end] = set.split(',').map(part => Number.parseInt(part.trim(), 10));
  if ([start, step, end].some(Number.isNaN) || step === 0) return [];
  const values: string[] = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) values.push(String(value));
  return values;
}

function parseFileOptions(text: string | null): FileOptions {
  const options: FileOptions = { eol: ';', skip: 0, delims: ' \t', tokens: [1], usebackq: false };
  if (text === null) return options;
  const keys = [...text.matchAll(/(^|\s)(eol|skip|delims|tokens|usebackq)(?==|\b)/gi)];
  keys.forEach((match, position) => {
    const keyStart = (match.index ?? 0) + match[1].length;
    const nextStart = position + 1 < keys.length ? (keys[position + 1].index ?? text.length) : text.length;
    const segment = text.slice(keyStart, nextStart);
    const key = match[2].toLowerCase();
    if (key === 'usebackq') { options.usebackq = true; return; }
    const value = segment.slice(segment.indexOf('=') + 1);
    if (key === 'eol') options.eol = value.slice(0, 1);
    else if (key === 'skip') options.skip = Number.parseInt(value, 10) || 0;
    else if (key === 'delims') options.delims = position + 1 < keys.length ? value.replace(/ $/, '') : value;
    else options.tokens = parseTokenSpec(value.trim());
  });
  return options;
}

function parseTokenSpec(spec: string): Array<number | 'rest'> {
  const tokens: Array<number | 'rest'> = [];
  for (const part of spec.split(',')) {
    if (part === '*') { tokens.push('rest'); continue; }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      for (let number = Number(range[1]); number <= Number(range[2]) && tokens.length < 31; number++) tokens.push(number);
      continue;
    }
    if (/^\d+$/.test(part)) tokens.push(Number(part));
  }
  return tokens.length === 0 ? [1] : tokens;
}

function splitLine(line: string, options: FileOptions): { tokens: string[]; rest: (from: number) => string } {
  const tokens: string[] = [];
  const starts: number[] = [];
  const isDelimiter = (character: string): boolean => options.delims.includes(character);
  let index = 0;
  if (options.delims === '') {
    return { tokens: [line], rest: () => line };
  }
  while (index < line.length) {
    while (index < line.length && isDelimiter(line[index])) index++;
    if (index >= line.length) break;
    if (options.eol !== '' && line[index] === options.eol) break;
    const start = index;
    while (index < line.length && !isDelimiter(line[index])) index++;
    tokens.push(line.slice(start, index));
    starts.push(start);
  }
  return {
    tokens,
    rest: from => {
      const start = starts[from];
      return start === undefined ? '' : line.slice(start);
    },
  };
}

function bindingsOf(line: string, source: ForSource, options: FileOptions): Map<string, string> | null {
  if (line === '') return null;
  const { tokens, rest } = splitLine(line, options);
  if (tokens.length === 0) return null;
  const bindings = new Map<string, string>();
  let variableCode = source.variable.charCodeAt(0);
  let previousIndex = -1;
  for (const wanted of options.tokens) {
    const name = String.fromCharCode(variableCode++);
    if (wanted === 'rest') {
      const remainder = rest(previousIndex + 1);
      if (remainder !== '') bindings.set(name, remainder);
      continue;
    }
    previousIndex = wanted - 1;
    const token = tokens[wanted - 1];
    if (token !== undefined) bindings.set(name, token);
  }
  return bindings.size === 0 ? null : bindings;
}

async function fileLines(
  host: BatchHost, source: ForSource, options: FileOptions, execute: (command: string) => Promise<string>,
): Promise<{ lines: string[]; messages: string[] }> {
  const text = source.set.trim();
  const messages: string[] = [];
  const quote = text[0];
  const wrapped = text.length >= 2 && text[text.length - 1] === quote ? text.slice(1, -1) : null;
  const literal = (value: string): string[] => value.split(/\r?\n/);

  if (wrapped !== null && quote === '"' && !options.usebackq) return { lines: literal(wrapped), messages };
  if (wrapped !== null && quote === "'" && options.usebackq) return { lines: literal(wrapped), messages };
  if (wrapped !== null && ((quote === "'" && !options.usebackq) || (quote === '`' && options.usebackq))) {
    const output = await execute(wrapped);
    return { lines: output === '' ? [] : output.split('\n'), messages };
  }

  const lines: string[] = [];
  const names = options.usebackq ? splitSetItems(text) : text.split(/\s+/).filter(name => name !== '');
  for (const name of names) {
    const path = host.fs.normalize(name.replace(/^"(.*)"$/, '$1'), host.cwd());
    const content = host.fs.read(path);
    if (content === null) { messages.push(`The system cannot find the file ${name}.`); continue; }
    lines.push(...content.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === '')));
  }
  return { lines, messages };
}

export async function enumerateFor(
  host: BatchHost, source: ForSource, execute: (command: string) => Promise<string>,
): Promise<ForIterations> {
  const single = (values: readonly string[]): ForIterations => ({
    bindings: values.map(value => new Map([[source.variable, value]])),
    messages: [],
  });

  switch (source.mode) {
    case 'l': return single(rangeValues(source.set.trim()));
    case 'plain': return single(plainValues(host, splitSetItems(source.set), false));
    case 'd': return single(plainValues(host, splitSetItems(source.set), true));
    case 'r': {
      const root = host.fs.normalize(source.root ?? host.cwd(), host.cwd());
      return single(recursiveValues(host, root, splitSetItems(source.set)));
    }
    case 'f': {
      const options = parseFileOptions(source.options);
      const { lines, messages } = await fileLines(host, source, options, execute);
      const bindings: Array<Map<string, string>> = [];
      for (const line of lines.slice(options.skip)) {
        const produced = bindingsOf(line, source, options);
        if (produced !== null) bindings.push(produced);
      }
      return { bindings, messages };
    }
  }
}
