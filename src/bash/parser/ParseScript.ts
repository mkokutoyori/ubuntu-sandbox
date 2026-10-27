import { BashLexer } from '@/bash/lexer/BashLexer';
import { TokenType } from '@/bash/lexer/Token';
import { BashParser } from './BashParser';
import { describeLexerError, describeParserError } from './SyntaxFailure';
import type { Program } from './ASTNode';

export function parseScript(source: string, firstLine = 1): Program {
  const { tokens, error: lexerError, warnings } = new BashLexer().tokenizeRecovering(source, true, firstLine);
  const { program, error: parserError } = new BashParser().parseRecovering(tokens, lexerError?.position.line);
  const withWarnings: Program = warnings.length === 0 ? program : { ...program, warnings };
  const parserFirst = parserError !== null && (lexerError === null || parserError.detail.token?.type !== TokenType.EOF);
  if (parserFirst) return { ...withWarnings, syntaxFailure: describeParserError(parserError, source, firstLine) };
  if (lexerError !== null) return { ...withWarnings, syntaxFailure: describeLexerError(lexerError, source, firstLine) };
  return withWarnings;
}
