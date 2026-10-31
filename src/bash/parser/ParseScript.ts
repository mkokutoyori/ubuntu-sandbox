import { BashLexer, type ExtglobPolicy } from '@/bash/lexer/BashLexer';
import { TokenType, type Token } from '@/bash/lexer/Token';
import { BashParser } from './BashParser';
import { describeLexerError, describeParserError, type SyntaxFailure } from './SyntaxFailure';
import type { Program } from './ASTNode';

const NESTED_SCRIPT_TOKENS: ReadonlySet<TokenType> = new Set([
  TokenType.CMD_SUB, TokenType.CMD_SUB_BACKTICK, TokenType.PROC_SUB_IN, TokenType.PROC_SUB_OUT,
]);

function restate(failure: SyntaxFailure, token: Token, source: string, firstLine: number): SyntaxFailure {
  const line = token.position.line;
  const outerText = source.split('\n')[line - firstLine] ?? '';
  const [head] = failure.diagnostics;
  if (head === undefined) return failure;
  const endOfInput = head.text === 'syntax error: unexpected end of file';
  if (!endOfInput && !head.text.startsWith('syntax error near')) return failure;
  return {
    line,
    diagnostics: [
      { line, text: endOfInput ? "syntax error near unexpected token `)'" : head.text },
      { line, text: `\`${outerText}'` },
    ],
  };
}

function quotedSubstitutions(text: string): string[] {
  const found: string[] = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '\\') { at++; continue; }
    if (text[at] !== '$' || text[at + 1] !== '(' || text[at + 2] === '(') continue;
    let depth = 1;
    let end = at + 2;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')') depth--;
    }
    found.push(text.slice(at + 2, depth === 0 ? end - 1 : end));
    at = end - 1;
  }
  return found;
}

function nestedFailure(tokens: readonly Token[], source: string, firstLine: number, extglob: ExtglobPolicy): SyntaxFailure | null {
  for (const token of tokens) {
    const bodies = NESTED_SCRIPT_TOKENS.has(token.type) ? [token.value]
      : token.type === TokenType.DOUBLE_QUOTED ? quotedSubstitutions(token.value) : [];
    for (const body of bodies) {
      const inner = parseScript(body, token.position.line, extglob);
      if (inner.syntaxFailure !== undefined) return restate(inner.syntaxFailure, token, source, firstLine);
    }
  }
  return null;
}

export function parseScript(source: string, firstLine = 1, extglob: ExtglobPolicy = 'always'): Program {
  const { tokens, error: lexerError, warnings } = new BashLexer().tokenizeRecovering(source, true, firstLine, extglob);
  const nested = nestedFailure(tokens, source, firstLine, extglob);
  const limit = Math.min(lexerError?.position.line ?? Infinity, nested?.line ?? Infinity);
  const { program, error: parserError, resumeLine } = new BashParser().parseRecovering(tokens, limit);
  const withWarnings: Program = warnings.length === 0 ? program : { ...program, warnings };
  const parserFirst = parserError !== null && (lexerError === null || parserError.detail.token?.type !== TokenType.EOF);
  const candidates: SyntaxFailure[] = [];
  if (parserFirst) candidates.push(describeParserError(parserError, source, firstLine));
  if (nested !== null) candidates.push(nested);
  if (candidates.length === 0 && lexerError !== null) candidates.push(describeLexerError(lexerError, source, firstLine));
  if (candidates.length === 0) return withWarnings;
  const earliest = candidates.reduce((best, next) => (next.line < best.line ? next : best));
  const resume = extglob === 'declared'
    ? { resume: { line: resumeLine, source: source.split('\n').slice(resumeLine - firstLine).join('\n') } }
    : {};
  return { ...withWarnings, syntaxFailure: earliest, ...resume };
}
