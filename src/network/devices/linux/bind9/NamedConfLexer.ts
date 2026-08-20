export type NamedConfTokenKind = 'word' | 'string' | '{' | '}' | ';' | '!';

export interface NamedConfToken {
  readonly kind: NamedConfTokenKind;
  readonly text: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export class NamedConfSyntaxError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly detail: string,
  ) {
    super(`${file}:${line}: ${detail}`);
    this.name = 'NamedConfSyntaxError';
  }
}

const PUNCTUATION = new Set(['{', '}', ';', '!']);

function isWordBreak(ch: string): boolean {
  return /\s/.test(ch) || PUNCTUATION.has(ch) || ch === '"';
}

export function lexNamedConf(source: string, file: string): NamedConfToken[] {
  const tokens: NamedConfToken[] = [];
  let line = 1;
  let column = 1;
  let i = 0;

  const advance = (): void => {
    if (source[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    i++;
  };

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      advance();
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      advance();
      advance();
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) advance();
      if (i >= source.length) {
        throw new NamedConfSyntaxError(file, startLine, 'unterminated comment');
      }
      advance();
      advance();
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      const startColumn = column;
      advance();
      let text = '';
      while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
        text += source[i];
        advance();
      }
      if (i >= source.length || source[i] === '\n') {
        throw new NamedConfSyntaxError(file, startLine, 'unterminated string');
      }
      advance();
      tokens.push({ kind: 'string', text, file, line: startLine, column: startColumn });
      continue;
    }

    if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: ch as NamedConfTokenKind, text: ch, file, line, column });
      advance();
      continue;
    }

    const startLine = line;
    const startColumn = column;
    let text = '';
    while (i < source.length && !isWordBreak(source[i])) {
      if (source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) break;
      text += source[i];
      advance();
    }
    tokens.push({ kind: 'word', text, file, line: startLine, column: startColumn });
  }

  return tokens;
}
