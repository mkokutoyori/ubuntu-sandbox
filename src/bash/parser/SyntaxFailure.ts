import { TokenType } from '@/bash/lexer/Token';
import type { Token } from '@/bash/lexer/Token';
import { LexerError } from '@/bash/lexer/LexerError';
import { ParserError } from './ParserError';

export interface DiagnosticLine {
  readonly line: number;
  readonly text: string;
}

export interface SyntaxFailure {
  readonly line: number;
  readonly diagnostics: readonly DiagnosticLine[];
}

const LEXER_CLOSERS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['single-quoted', "'", false],
  ['double-quoted', '"', false],
  ['backtick', '`', false],
  ['arithmetic substitution', ')', true],
  ['command substitution', ')', true],
  ['variable expansion', '}', false],
  ['process substitution', ')', true],
];

function sourceLine(source: string, line: number, firstLine: number): string {
  return source.split('\n')[line - firstLine] ?? '';
}

function endOfFileLine(source: string, firstLine: number): number {
  return source.split('\n').length + firstLine - 1;
}

function unmatched(closer: string, line: number): SyntaxFailure {
  return { line, diagnostics: [{ line, text: `unexpected EOF while looking for matching \`${closer}'` }] };
}

function unexpectedEnd(source: string, firstLine: number): SyntaxFailure {
  const line = endOfFileLine(source, firstLine);
  return { line, diagnostics: [{ line, text: 'syntax error: unexpected end of file' }] };
}

function nearToken(source: string, token: Token, firstLine: number): SyntaxFailure {
  const line = token.position.line;
  const shown = token.type === TokenType.NEWLINE ? 'newline' : token.value;
  return {
    line,
    diagnostics: [
      { line, text: `syntax error near unexpected token \`${shown}'` },
      { line, text: `\`${sourceLine(source, line, firstLine)}'` },
    ],
  };
}

export function describeLexerError(error: LexerError, source: string, firstLine = 1): SyntaxFailure {
  const match = LEXER_CLOSERS.find(([name]) => error.message.includes(name));
  const closer = match?.[1] ?? '"';
  const atEnd = match?.[2] ?? false;
  return unmatched(closer, atEnd ? endOfFileLine(source, firstLine) : error.position.line);
}

export function describeParserError(error: ParserError, source: string, firstLine = 1): SyntaxFailure {
  const { token, closer, conditional } = error.detail;
  if (closer !== undefined) return unmatched(closer, error.position.line);
  if (conditional !== undefined && token !== undefined) {
    const line = token.position.line;
    return {
      line,
      diagnostics: [
        { line, text: `unexpected argument \`${token.value}' to conditional ${conditional} operator` },
        { line, text: `syntax error near \`${token.value}'` },
        { line, text: `\`${sourceLine(source, line, firstLine)}'` },
      ],
    };
  }
  if (token === undefined || token.type === TokenType.EOF) return unexpectedEnd(source, firstLine);
  return nearToken(source, token, firstLine);
}
