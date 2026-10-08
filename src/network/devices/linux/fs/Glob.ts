const CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
};

const escapeRegex = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

interface Bracket {
  readonly source: string;
  readonly end: number;
}

function readBracket(pattern: string, open: number): Bracket | null {
  let i = open + 1;
  let negate = false;
  if (pattern[i] === '!' || pattern[i] === '^') {
    negate = true;
    i++;
  }
  let body = '';
  let first = true;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === ']' && !first) {
      return { source: `[${negate ? '^' : ''}${body}]`, end: i + 1 };
    }
    first = false;
    if (char === '[' && pattern[i + 1] === ':') {
      const close = pattern.indexOf(':]', i + 2);
      if (close > 0) {
        const range = CLASSES[pattern.slice(i + 2, close)];
        if (range === undefined) return null;
        body += range;
        i = close + 2;
        continue;
      }
    }
    if (char === '\\' && i + 1 < pattern.length) {
      body += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (char === '-' && body !== '' && pattern[i + 1] !== ']') {
      body += '-';
      i++;
      continue;
    }
    body += char === ']' || char === '^' || char === '\\' ? `\\${char}` : char;
    i++;
  }
  return null;
}

function toRegexSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      out += '.*';
      i++;
    } else if (char === '?') {
      out += '.';
      i++;
    } else if (char === '[') {
      const bracket = readBracket(pattern, i);
      if (bracket === null) {
        out += '\\[';
        i++;
      } else {
        out += bracket.source;
        i = bracket.end;
      }
    } else if (char === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]);
      i += 2;
    } else {
      out += escapeRegex(char);
      i++;
    }
  }
  return out;
}

export interface FnmatchOptions {
  readonly period?: boolean;
}

export function fnmatch(pattern: string, text: string, options: FnmatchOptions = {}): boolean {
  if (options.period === true && text.startsWith('.') && !pattern.startsWith('.') && !pattern.startsWith('\\.')) {
    return false;
  }
  return new RegExp(`^${toRegexSource(pattern)}$`, 's').test(text);
}

export function hasMagic(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
    } else if (char === '*' || char === '?' || (char === '[' && readBracket(pattern, i) !== null)) {
      return true;
    }
  }
  return false;
}

const unescape = (pattern: string): string => pattern.replace(/\\(.)/gs, '$1');

export interface GlobFileSystem {
  listNames(directory: string): readonly string[] | null;
  existsNoFollow(path: string): boolean;
  isDirectory(path: string): boolean;
}

export interface GlobOptions {
  readonly noCheck?: boolean;
  readonly home?: string;
}

function expandComponents(
  fs: GlobFileSystem, base: string, components: readonly string[], index: number, out: string[],
): void {
  if (index >= components.length) {
    out.push(base);
    return;
  }
  const component = components[index];
  const join = (name: string): string => (base === '' || base.endsWith('/') ? `${base}${name}` : `${base}/${name}`);
  const last = index === components.length - 1;
  if (!hasMagic(component)) {
    const path = join(unescape(component));
    if (fs.existsNoFollow(path) && (last || fs.isDirectory(path))) {
      expandComponents(fs, path, components, index + 1, out);
    }
    return;
  }
  const names = fs.listNames(base === '' ? '.' : base);
  if (names === null) return;
  for (const name of [...names].sort()) {
    if (!fnmatch(component, name, { period: true })) continue;
    const path = join(name);
    if (last || fs.isDirectory(path)) expandComponents(fs, path, components, index + 1, out);
  }
}

export function globPaths(fs: GlobFileSystem, pattern: string, options: GlobOptions = {}): string[] {
  let effective = pattern;
  if (options.home !== undefined && (pattern === '~' || pattern.startsWith('~/'))) {
    effective = `${options.home}${pattern.slice(1)}`;
  }
  const absolute = effective.startsWith('/');
  const components = effective.split('/').filter((part) => part !== '');
  const found: string[] = [];
  expandComponents(fs, absolute ? '/' : '', components, 0, found);
  const trailing = effective.endsWith('/') && effective.length > 1;
  const sorted = [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const matches = trailing ? sorted.filter((path) => fs.isDirectory(path)).map((path) => `${path}/`) : sorted;
  if (matches.length === 0 && options.noCheck === true) return [pattern];
  return matches;
}
