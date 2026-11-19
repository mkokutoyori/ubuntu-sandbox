export interface ConfPair {
  readonly name: string;
  readonly op: string;
  readonly value: string;
  readonly quoted: boolean;
  readonly file: string;
  readonly line: number;
}

export interface ConfSection {
  readonly name1: string;
  readonly name2: string | null;
  readonly pairs: ConfPair[];
  readonly sections: ConfSection[];
  readonly file: string;
  readonly line: number;
}

export type ConfParseResult =
  | { readonly ok: true; readonly root: ConfSection }
  | { readonly ok: false; readonly error: string };

export type ConfFileReader = (path: string) => string | null;

const OPERATORS = ['===', '!==', ':=', '+=', '-=', '==', '!=', '<=', '>=', '=~', '!~', '^=', '=', '<', '>'];

interface Token {
  readonly kind: 'word' | 'quoted' | 'op' | 'lbrace' | 'rbrace' | 'comma' | 'eol';
  readonly text: string;
}

class ParseFailure extends Error {}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function joinPath(base: string, relative: string): string {
  return relative.startsWith('/') ? relative : `${base}/${relative}`;
}

function logicalLines(source: string): Array<{ text: string; line: number }> {
  const physical = source.split('\n');
  const logical: Array<{ text: string; line: number }> = [];
  let buffer = '';
  let start = 0;
  physical.forEach((raw, index) => {
    const text = raw.replace(/\r$/, '');
    if (buffer === '') start = index + 1;
    if (text.endsWith('\\')) {
      buffer += text.slice(0, -1);
      return;
    }
    logical.push({ text: buffer + text, line: start });
    buffer = '';
  });
  if (buffer !== '') logical.push({ text: buffer, line: start });
  return logical;
}

export function parseFreeradiusConf(source: string, fileName: string, readFile: ConfFileReader = () => null): ConfParseResult {
  const root: ConfSection = { name1: '', name2: null, pairs: [], sections: [], file: fileName, line: 0 };
  try {
    readInto(source, fileName, readFile, [root], 0);
    return { ok: true, root };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.message };
    throw error;
  }
}

function lookupVariable(stack: readonly ConfSection[], name: string): string | null {
  for (let index = stack.length - 1; index >= 0; index--) {
    const found = stack[index].pairs.find((pair) => pair.name === name);
    if (found !== undefined) return found.value;
  }
  return null;
}

function expand(text: string, stack: readonly ConfSection[], file: string, line: number): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('${', index)) {
      const close = text.indexOf('}', index);
      if (close === -1) throw new ParseFailure(`${file}[${line}]: Variable expansion missing }`);
      const name = text.slice(index + 2, close);
      const value = lookupVariable(stack, name);
      if (value === null) throw new ParseFailure(`${file}[${line}]: Reference '\${${name}}' not found`);
      result += value;
      index = close + 1;
    } else if (text.startsWith('$ENV{', index)) {
      const close = text.indexOf('}', index);
      if (close === -1) throw new ParseFailure(`${file}[${line}]: Environment variable expansion missing }`);
      index = close + 1;
    } else {
      result += text[index];
      index += 1;
    }
  }
  return result;
}

function tokenize(text: string, file: string, line: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t') {
      index += 1;
    } else if (char === '#') {
      break;
    } else if (char === '{') {
      tokens.push({ kind: 'lbrace', text: '{' });
      index += 1;
    } else if (char === '}') {
      tokens.push({ kind: 'rbrace', text: '}' });
      index += 1;
    } else if (char === ',') {
      tokens.push({ kind: 'comma', text: ',' });
      index += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      let value = '';
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '\\' && index + 1 < text.length) {
          const next = text[index + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          index += 2;
        } else if (text[index] === char) {
          closed = true;
          index += 1;
          break;
        } else {
          value += text[index];
          index += 1;
        }
      }
      if (!closed) throw new ParseFailure(`${file}[${line}]: Parse error: Unterminated quoted string`);
      tokens.push({ kind: 'quoted', text: value });
    } else {
      const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
      if (operator !== undefined) {
        tokens.push({ kind: 'op', text: operator });
        index += operator.length;
      } else {
        let end = index;
        while (end < text.length) {
          if (text.startsWith('${', end) || text.startsWith('$ENV{', end)) {
            const close = text.indexOf('}', end);
            end = close === -1 ? text.length : close + 1;
            continue;
          }
          if (/[\s{},#=]/.test(text[end]) || OPERATORS.some((candidate) => candidate.length > 1 && text.startsWith(candidate, end))) break;
          end += 1;
        }
        if (end === index) end += 1;
        tokens.push({ kind: 'word', text: text.slice(index, end) });
        index = end;
      }
    }
  }
  tokens.push({ kind: 'eol', text: '' });
  return tokens;
}

function readInto(
  source: string, file: string, readFile: ConfFileReader, stack: ConfSection[], depth: number,
): void {
  const baseStackLength = stack.length;
  let lastLine = 0;
  for (const { text, line } of logicalLines(source)) {
    lastLine = line;
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('$INCLUDE')) {
      const argument = trimmed.slice('$INCLUDE'.length).trim();
      if (argument === '') throw new ParseFailure(`${file}[${line}]: Unexpected text after $INCLUDE`);
      const path = joinPath(dirname(file), expand(argument.replace(/^["']|["']$/g, ''), stack, file, line));
      const included = readFile(path);
      if (included === null) {
        if (trimmed.startsWith('$INCLUDE-')) continue;
        throw new ParseFailure(`${file}[${line}]: Unable to open file '${path}': No such file or directory`);
      }
      if (depth > 16) throw new ParseFailure(`${file}[${line}]: Directories too deep.`);
      readInto(included, path, readFile, stack, depth + 1);
      continue;
    }
    const tokens = tokenize(text, file, line);
    const current = stack[stack.length - 1];
    const first = tokens[0];
    if (first.kind === 'rbrace') {
      if (stack.length === baseStackLength) throw new ParseFailure(`${file}[${line}]: Too many closing braces`);
      stack.pop();
      continue;
    }
    if (first.kind !== 'word' && first.kind !== 'quoted') {
      throw new ParseFailure(`${file}[${line}]: Parse error after '${current.name1}': unexpected token '${first.text}'`);
    }
    const second = tokens[1];
    if (second.kind === 'op') {
      const valueToken = tokens[2];
      if (valueToken.kind === 'eol' || valueToken.kind === 'lbrace' || valueToken.kind === 'rbrace') {
        throw new ParseFailure(`${file}[${line}]: Parse error: Missing value for '${first.text}'`);
      }
      const value = expand(valueToken.text, stack, file, line);
      current.pairs.push({ name: first.text, op: second.text, value, quoted: valueToken.kind === 'quoted', file, line });
      continue;
    }
    let name2: string | null = null;
    let braceAt = 1;
    if (second.kind === 'word' || second.kind === 'quoted') {
      name2 = expand(second.text, stack, file, line);
      braceAt = 2;
    }
    if (tokens[braceAt].kind !== 'lbrace') {
      const offender = tokens[braceAt].kind === 'eol' ? 'end of line' : tokens[braceAt].text;
      throw new ParseFailure(`${file}[${line}]: Parse error after '${first.text}': unexpected token '${offender}'`);
    }
    const section: ConfSection = { name1: first.text, name2, pairs: [], sections: [], file, line };
    current.sections.push(section);
    stack.push(section);
  }
  if (stack.length > baseStackLength) {
    const open = stack[stack.length - 1];
    throw new ParseFailure(`${file}[${lastLine}]: EOF reached without closing brace for section ${open.name1} starting at line ${open.line}`);
  }
}
