export function textLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface FindstrOptions {
  readonly patterns: readonly string[];
  readonly ignoreCase: boolean;
  readonly invert: boolean;
  readonly regex: boolean;
  readonly numbered: boolean;
}

export type FindstrParse =
  | { readonly options: FindstrOptions; readonly files: string[] }
  | { readonly error: string };

const FINDSTR_USAGE = 'FINDSTR: Wrong number of arguments';

export function parseFindstrArguments(args: readonly string[]): FindstrParse {
  let ignoreCase = false;
  let invert = false;
  let regex = false;
  let numbered = false;
  let literalPhrase: string | null = null;
  const positional: string[] = [];
  for (const argument of args) {
    const lowered = argument.toLowerCase();
    if (lowered === '/i') ignoreCase = true;
    else if (lowered === '/v') invert = true;
    else if (lowered === '/n') numbered = true;
    else if (lowered === '/r') regex = true;
    else if (lowered === '/l') regex = false;
    else if (lowered === '/s' || lowered === '/b' || lowered === '/e' || lowered === '/x' || lowered === '/o') continue;
    else if (lowered.startsWith('/c:')) literalPhrase = argument.slice(3).replace(/^"|"$/g, '');
    else positional.push(argument);
  }
  let patterns: string[];
  let files: string[];
  if (literalPhrase !== null) {
    patterns = [literalPhrase];
    files = positional;
  } else {
    if (positional.length === 0) return { error: FINDSTR_USAGE };
    patterns = positional[0].split(/\s+/).filter(word => word !== '');
    files = positional.slice(1);
  }
  if (patterns.length === 0) return { error: FINDSTR_USAGE };
  return { options: { patterns, ignoreCase, invert, regex: regex && literalPhrase === null, numbered }, files };
}

function patternMatcher(options: FindstrOptions): ((line: string) => boolean) | null {
  const flags = options.ignoreCase ? 'i' : '';
  try {
    const expressions = options.patterns.map(pattern =>
      new RegExp(options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags));
    return line => expressions.some(expression => expression.test(line));
  } catch {
    return null;
  }
}

export function filterFindstr(lines: readonly string[], options: FindstrOptions, filePrefix = ''): string[] | null {
  const matches = patternMatcher(options);
  if (matches === null) return null;
  const selected: string[] = [];
  lines.forEach((line, index) => {
    if (matches(line) === options.invert) return;
    selected.push(`${filePrefix}${options.numbered ? `${index + 1}:` : ''}${line}`);
  });
  return selected;
}

export function applyFindstrArguments(text: string, args: readonly string[]): string {
  const parsed = parseFindstrArguments(args);
  if ('error' in parsed) return '';
  return (filterFindstr(textLines(text), parsed.options) ?? []).join('\n');
}

export interface FindOptions {
  readonly text: string;
  readonly ignoreCase: boolean;
  readonly invert: boolean;
  readonly count: boolean;
  readonly numbered: boolean;
}

export type FindParse =
  | { readonly options: FindOptions; readonly files: string[] }
  | { readonly error: string };

const FIND_USAGE = 'FIND: Parameter format not correct';

export function parseFindArguments(args: readonly string[]): FindParse {
  let ignoreCase = false;
  let invert = false;
  let count = false;
  let numbered = false;
  let text: string | null = null;
  const files: string[] = [];
  for (const argument of args) {
    const lowered = argument.toLowerCase();
    if (lowered === '/i') ignoreCase = true;
    else if (lowered === '/v') invert = true;
    else if (lowered === '/c') count = true;
    else if (lowered === '/n') numbered = true;
    else if (text === null) text = argument.replace(/^"(.*)"$/, '$1');
    else files.push(argument);
  }
  if (text === null) return { error: FIND_USAGE };
  return { options: { text, ignoreCase, invert, count, numbered }, files };
}

export function filterFind(lines: readonly string[], options: FindOptions): { shown: string[]; count: number } {
  const needle = options.ignoreCase ? options.text.toLowerCase() : options.text;
  const shown: string[] = [];
  let count = 0;
  lines.forEach((line, index) => {
    const haystack = options.ignoreCase ? line.toLowerCase() : line;
    if (haystack.includes(needle) === options.invert) return;
    count++;
    shown.push(options.numbered ? `[${index + 1}]${line}` : line);
  });
  return { shown, count };
}
