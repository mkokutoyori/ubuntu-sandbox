import { TokenType } from '@/bash/lexer/Token';
import type { Token } from '@/bash/lexer/Token';
import { LexerError } from '@/bash/lexer/LexerError';
import { ParserError } from './ParserError';

export interface DiagnosticLine {
  readonly line: number;
  readonly text: string;
  readonly dash?: string;
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
  ['extended pattern', ')', false],
];

function sourceLine(source: string, line: number, firstLine: number): string {
  return source.split('\n')[line - firstLine] ?? '';
}

function endOfFileLine(source: string, firstLine: number): number {
  return source.split('\n').length + firstLine - 1;
}

function dashUnmatched(closer: string, line: number, endLine: number, arithmetic = false): { line: number; text: string } {
  if (arithmetic) return { line: endLine, text: "Syntax error: Missing '))'" };
  if (closer === "'" || closer === '"') return { line: endLine, text: 'Syntax error: Unterminated quoted string' };
  if (closer === '`') return { line: endLine, text: 'Syntax error: EOF in backquote substitution' };
  if (closer === '}') return { line, text: "Syntax error: Missing '}'" };
  return { line: endLine, text: `Syntax error: end of file unexpected (expecting "${closer}")` };
}

function unmatched(closer: string, line: number, endLine = line, arithmetic = false): SyntaxFailure {
  const dash = dashUnmatched(closer, line, endLine, arithmetic);
  return { line, diagnostics: [{ line, text: `unexpected EOF while looking for matching \`${closer}'`, dash: `${dash.line}: ${dash.text}` }] };
}

function unexpectedEnd(source: string, firstLine: number, expecting?: string): SyntaxFailure {
  const line = endOfFileLine(source, firstLine);
  return { line, diagnostics: [{ line, text: 'syntax error: unexpected end of file', dash: `${line}: Syntax error: end of file unexpected${expectingSuffix(expecting)}` }] };
}

function expectingSuffix(expecting: string | undefined): string {
  return expecting === undefined ? '' : ` (expecting "${expecting}")`;
}

function nearToken(source: string, token: Token, firstLine: number, expecting?: string, asWord = false): SyntaxFailure {
  const line = token.position.line;
  const dashLine = token.type === TokenType.NEWLINE ? line + 1 : line;
  const shown = token.type === TokenType.NEWLINE ? 'newline' : token.value;
  const dashShown = token.type === TokenType.NEWLINE ? 'newline' : asWord ? 'word' : `"${token.value}"`;
  return {
    line,
    diagnostics: [
      { line, text: `syntax error near unexpected token \`${shown}'`, dash: `${dashLine}: Syntax error: ${dashShown} unexpected${expectingSuffix(expecting)}` },
      { line, text: `\`${sourceLine(source, line, firstLine)}'` },
    ],
  };
}

export function describeLexerError(error: LexerError, source: string, firstLine = 1): SyntaxFailure {
  const match = LEXER_CLOSERS.find(([name]) => error.message.includes(name));
  const closer = match?.[1] ?? '"';
  const atEnd = match?.[2] ?? false;
  return unmatched(closer, atEnd ? endOfFileLine(source, firstLine) : error.position.line, endOfFileLine(source, firstLine), match?.[0] === 'arithmetic substitution');
}

export function describeParserError(error: ParserError, source: string, firstLine = 1): SyntaxFailure {
  const { token, closer, conditional, expecting } = error.detail;
  if (closer !== undefined) return unmatched(closer, error.position.line, endOfFileLine(source, firstLine));
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
  if (token === undefined || token.type === TokenType.EOF) return unexpectedEnd(source, firstLine, expecting);
  return nearToken(source, token, firstLine, expecting, error.detail.asWord === true);
}
