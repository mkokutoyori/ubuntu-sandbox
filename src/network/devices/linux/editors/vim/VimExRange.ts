export interface RangeEnvironment {
  readonly lineCount: number;
  readonly cursorLine: number;
  mark(name: string): number | null;
  search(pattern: string, forward: boolean, fromLine: number): { line: number } | { error: string };
  repeatSearch(source: 'search' | 'substitute', forward: boolean, fromLine: number): { line: number } | { error: string };
}

export interface ParsedRange {
  readonly first: number | null;
  readonly last: number | null;
  readonly addressCount: number;
  readonly rest: string;
  readonly literal: string;
  readonly error: string | null;
  readonly cursorAfter: number | null;
}

interface AddressResult {
  readonly line: number | null;
  readonly at: number;
  readonly error: string | null;
}

function skipWhite(text: string, from: number): number {
  let at = from;
  while (text[at] === ' ' || text[at] === '\t') at++;
  return at;
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function readDigits(text: string, from: number): { value: number; next: number } {
  let at = from;
  while (isDigit(text[at])) at++;
  return { value: Number(text.slice(from, at)), next: at };
}

function skipPattern(text: string, from: number, delimiter: string): number {
  let at = from;
  while (at < text.length && text[at] !== delimiter) {
    if (text[at] === '\\' && at + 1 < text.length) at++;
    at++;
  }
  return at;
}

function getAddress(text: string, from: number, env: RangeEnvironment, cursor: number): AddressResult {
  let at = skipWhite(text, from);
  let line: number | null = null;
  const fail = (error: string): AddressResult => ({ line: null, at, error });
  do {
    const character = text[at];
    if (character === '.') {
      at++;
      line = cursor;
    } else if (character === '$') {
      at++;
      line = env.lineCount;
    } else if (character === "'") {
      at++;
      if (at >= text.length) return fail('');
      const found = env.mark(text[at]);
      at++;
      if (found === null) return fail('E20: Mark not set');
      line = found;
    } else if (character === '/' || character === '?') {
      at++;
      const end = skipPattern(text, at, character);
      const pattern = text.slice(at, end);
      at = end < text.length ? end + 1 : end;
      let fromLine = cursor;
      if (line !== null) fromLine = Math.min(line, env.lineCount);
      const found = pattern === '' ? env.repeatSearch('search', character === '/', fromLine) : env.search(pattern, character === '/', fromLine);
      if ('error' in found) return fail(found.error);
      line = found.line;
    } else if (character === '\\') {
      at++;
      const kind = text[at];
      if (kind !== '&' && kind !== '?' && kind !== '/') return fail('E10: \\ should be followed by /, ? or &');
      const fromLine = line ?? cursor;
      const found = env.repeatSearch(kind === '&' ? 'substitute' : 'search', kind !== '?', fromLine);
      if ('error' in found) return fail(found.error);
      line = found.line;
      at++;
    } else if (isDigit(character)) {
      const digits = readDigits(text, at);
      line = digits.value;
      at = digits.next;
    }

    for (;;) {
      at = skipWhite(text, at);
      const sign = text[at];
      if (sign !== '-' && sign !== '+' && !isDigit(sign)) break;
      if (line === null) line = cursor;
      let operator = '+';
      if (!isDigit(sign)) {
        operator = sign;
        at++;
      }
      let amount = 1;
      if (isDigit(text[at])) {
        const digits = readDigits(text, at);
        amount = digits.value;
        at = digits.next;
      }
      line = operator === '-' ? line - amount : line + amount;
    }
  } while (text[at] === '/' || text[at] === '?');
  return { line, at, error: null };
}

export function parseRange(text: string, env: RangeEnvironment): ParsedRange {
  let at = 0;
  let cursor = env.cursorLine;
  let first = cursor;
  let last = cursor;
  let count = 0;
  let movedTo: number | null = null;
  let lastWasNone = false;
  for (;;) {
    first = last;
    last = cursor;
    at = skipWhite(text, at);
    const address = getAddress(text, at, env, cursor);
    if (address.error !== null) {
      return { first: null, last: null, addressCount: 0, rest: text.slice(address.at), literal: text.slice(0, address.at), error: address.error, cursorAfter: movedTo };
    }
    at = address.at;
    lastWasNone = address.line === null;
    if (address.line === null) {
      if (text[at] === '%') {
        at++;
        first = 1;
        last = env.lineCount;
        count++;
      }
    } else {
      last = address.line;
    }
    count++;
    if (text[at] === ';') {
      cursor = last;
      movedTo = last;
    } else if (text[at] !== ',') {
      break;
    }
    at++;
  }
  if (count === 1) {
    first = last;
    if (lastWasNone) count = 0;
  }
  return { first, last, addressCount: count, rest: text.slice(at), literal: text.slice(0, at), error: null, cursorAfter: movedTo };
}
