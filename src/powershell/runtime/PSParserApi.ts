import type { PSValue } from './PSEnvironment';
import type { PSLexer } from '@/powershell/lexer/PSLexer';
import type { PSParser } from '@/powershell/parser/PSParser';
import { PSParserError } from '@/powershell/parser/PSParserError';
import { PSTokenType, PS_KEYWORDS, PS_OPERATOR_PARAMS, tokenText, type PSToken } from '@/powershell/lexer/PSToken';

function publicKind(token: PSToken): string {
  switch (token.type) {
    case PSTokenType.WORD: return PS_KEYWORDS.has(token.value) ? 'Keyword' : 'Command';
    case PSTokenType.NUMBER: return 'Number';
    case PSTokenType.STRING_SINGLE: case PSTokenType.STRING_DOUBLE:
    case PSTokenType.HEREDOC_SINGLE: case PSTokenType.HEREDOC_DOUBLE: return 'String';
    case PSTokenType.VARIABLE: case PSTokenType.SPLATTED: return 'Variable';
    case PSTokenType.PARAMETER: return PS_OPERATOR_PARAMS.has(token.value) ? 'Operator' : 'CommandParameter';
    case PSTokenType.TYPE: return 'Type';
    case PSTokenType.SEMICOLON: return 'StatementSeparator';
    case PSTokenType.NEWLINE: return 'NewLine';
    case PSTokenType.LPAREN: case PSTokenType.LBRACE: case PSTokenType.LBRACKET: case PSTokenType.SUBEXPR: return 'GroupStart';
    case PSTokenType.RPAREN: case PSTokenType.RBRACE: case PSTokenType.RBRACKET: return 'GroupEnd';
    case PSTokenType.AT: return 'Operator';
    default: return 'Operator';
  }
}

function tokenObject(token: PSToken): Record<string, PSValue> {
  const content = tokenText(token);
  return {
    Type: publicKind(token),
    Content: content,
    Start: token.position.offset,
    Length: content.length,
    StartLine: token.position.line,
    StartColumn: token.position.column,
    EndLine: token.position.line,
    EndColumn: token.position.column + content.length,
  };
}

export function psParserStatics(lexer: PSLexer, parser: PSParser): Record<string, PSValue> {
  return {
    tokenize: (script: PSValue, errors?: PSValue) => {
      const source = String(script ?? '');
      const found: PSValue[] = [];
      let tokens: PSToken[] = [];
      try {
        tokens = lexer.tokenize(source);
        parser.parse(tokens, source);
      } catch (error) {
        const message = error instanceof PSParserError ? error.reason : error instanceof Error ? error.message : String(error);
        const where = error instanceof PSParserError ? error.position : undefined;
        found.push({ Message: message, Token: { Start: where?.offset ?? 0, StartLine: where?.line ?? 1, StartColumn: where?.column ?? 1, Length: 1, Content: '' } } as unknown as PSValue);
      }
      if (errors !== null && errors !== undefined && typeof errors === 'object') (errors as Record<string, PSValue>).Value = found;
      return tokens.filter(token => token.type !== PSTokenType.EOF).map(tokenObject) as unknown as PSValue;
    },
  };
}
