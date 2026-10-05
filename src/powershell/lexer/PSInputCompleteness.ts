import { PSLexer } from './PSLexer';
import { PSLexerError } from './PSLexerError';
import { PSTokenType, type PSToken } from './PSToken';

const OPENERS: ReadonlySet<PSTokenType> = new Set([
  PSTokenType.LPAREN, PSTokenType.LBRACE, PSTokenType.LBRACKET,
]);
const CLOSERS: ReadonlySet<PSTokenType> = new Set([
  PSTokenType.RPAREN, PSTokenType.RBRACE, PSTokenType.RBRACKET,
]);
const INSIGNIFICANT: ReadonlySet<PSTokenType> = new Set([PSTokenType.NEWLINE, PSTokenType.EOF]);

function lastSignificant(tokens: readonly PSToken[]): PSToken | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (!INSIGNIFICANT.has(tokens[index].type)) return tokens[index];
  }
  return undefined;
}

export function powershellInputIsIncomplete(source: string): boolean {
  const lexer = new PSLexer();
  let tokens: PSToken[];
  try {
    tokens = lexer.tokenize(`${source}\n`);
  } catch (error) {
    return error instanceof PSLexerError && error.reason.startsWith('Unterminated');
  }
  if (lexer.endsInLineContinuation) return true;

  let depth = 0;
  for (const token of tokens) {
    if (OPENERS.has(token.type)) depth++;
    else if (CLOSERS.has(token.type)) depth--;
  }
  return depth > 0 || lastSignificant(tokens)?.type === PSTokenType.PIPE;
}
