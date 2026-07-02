import { lexNamedConf, NamedConfSyntaxError } from './NamedConfLexer';
import type { NamedConfToken } from './NamedConfLexer';

export interface NamedConfValue {
  readonly text: string;
  readonly quoted: boolean;
}

export type NamedConfPart =
  | { readonly kind: 'value'; readonly value: NamedConfValue }
  | { readonly kind: 'block'; readonly statements: readonly NamedConfStatement[] };

export interface NamedConfStatement {
  readonly values: readonly NamedConfValue[];
  readonly block: readonly NamedConfStatement[] | null;
  readonly parts: readonly NamedConfPart[];
  readonly file: string;
  readonly line: number;
}

export type IncludeReader = (path: string) => string | null;

export interface ParseNamedConfOptions {
  readonly file?: string;
  readonly readInclude?: IncludeReader;
}

const DEFAULT_FILE = '/etc/bind/named.conf';

class TokenCursor {
  private index = 0;

  constructor(
    private readonly tokens: readonly NamedConfToken[],
    readonly file: string,
  ) {}

  peek(): NamedConfToken | null {
    return this.tokens[this.index] ?? null;
  }

  next(): NamedConfToken | null {
    const token = this.tokens[this.index] ?? null;
    if (token) this.index++;
    return token;
  }

  lastLine(): number {
    const token = this.tokens[this.tokens.length - 1];
    return token ? token.line : 1;
  }
}

function parseStatements(
  cursor: TokenCursor,
  readInclude: IncludeReader | undefined,
  openBrace: NamedConfToken | null,
): NamedConfStatement[] {
  const statements: NamedConfStatement[] = [];

  for (;;) {
    const token = cursor.peek();

    if (token === null) {
      if (openBrace) {
        throw new NamedConfSyntaxError(
          openBrace.file, openBrace.line, "missing '}' before end of file",
        );
      }
      return statements;
    }

    if (token.kind === '}') {
      if (!openBrace) {
        throw new NamedConfSyntaxError(token.file, token.line, "unexpected '}'");
      }
      cursor.next();
      return statements;
    }

    statements.push(...parseStatement(cursor, readInclude));
  }
}

function parseStatement(
  cursor: TokenCursor,
  readInclude: IncludeReader | undefined,
): NamedConfStatement[] {
  const first = cursor.peek();
  if (first === null || first.kind === '}') {
    throw new NamedConfSyntaxError(cursor.file, cursor.lastLine(), 'unexpected end of statement');
  }
  if (first.kind === ';' || first.kind === '{') {
    throw new NamedConfSyntaxError(first.file, first.line, `unexpected '${first.text}'`);
  }

  const parts: NamedConfPart[] = [];

  for (;;) {
    const token = cursor.peek();

    if (token === null) {
      throw new NamedConfSyntaxError(
        first.file, first.line, "missing ';' before end of file",
      );
    }

    if (token.kind === ';') {
      cursor.next();
      break;
    }

    if (token.kind === '}') {
      throw new NamedConfSyntaxError(token.file, token.line, "missing ';' before '}'");
    }

    if (token.kind === '{') {
      cursor.next();
      parts.push({ kind: 'block', statements: parseStatements(cursor, readInclude, token) });
      continue;
    }

    cursor.next();
    parts.push({ kind: 'value', value: { text: token.text, quoted: token.kind === 'string' } });
  }

  const values = parts
    .filter((part): part is Extract<NamedConfPart, { kind: 'value' }> => part.kind === 'value')
    .map((part) => part.value);
  const firstBlock = parts.find(
    (part): part is Extract<NamedConfPart, { kind: 'block' }> => part.kind === 'block',
  );
  const block = firstBlock ? [...firstBlock.statements] : null;

  if (values.length === 0) {
    throw new NamedConfSyntaxError(first.file, first.line, 'empty statement');
  }

  if (values[0].text === 'include' && block === null) {
    return expandInclude(values, first, readInclude);
  }

  return [{ values, block, parts, file: first.file, line: first.line }];
}

function expandInclude(
  values: readonly NamedConfValue[],
  first: NamedConfToken,
  readInclude: IncludeReader | undefined,
): NamedConfStatement[] {
  if (values.length !== 2) {
    throw new NamedConfSyntaxError(first.file, first.line, "'include' takes exactly one file name");
  }
  const path = values[1].text;
  const content = readInclude ? readInclude(path) : null;
  if (content === null) {
    throw new NamedConfSyntaxError(first.file, first.line, `open: ${path}: file not found`);
  }
  return parseNamedConfSource(content, path, readInclude);
}

function parseNamedConfSource(
  source: string,
  file: string,
  readInclude: IncludeReader | undefined,
): NamedConfStatement[] {
  const cursor = new TokenCursor(lexNamedConf(source, file), file);
  return parseStatements(cursor, readInclude, null);
}

export function parseNamedConf(
  source: string,
  options: ParseNamedConfOptions = {},
): NamedConfStatement[] {
  return parseNamedConfSource(source, options.file ?? DEFAULT_FILE, options.readInclude);
}
