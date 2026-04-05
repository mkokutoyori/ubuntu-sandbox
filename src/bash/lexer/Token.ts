/**
 * Token — Token types and token structure for the bash lexer.
 *
 * Mirrors the PLY grammar specification (bash_grammar.py).
 * Each token carries its type, raw value, and source position
 * for accurate error reporting.
 */

// ─── Token Types ────────────────────────────────────────────────────

export enum TokenType {
  // Literals & identifiers
  WORD = 'WORD',
  ASSIGNMENT_WORD = 'ASSIGNMENT_WORD',   // VAR=value
  NUMBER = 'NUMBER',

  // Strings
  SINGLE_QUOTED = 'SINGLE_QUOTED',       // 'literal'
  DOUBLE_QUOTED = 'DOUBLE_QUOTED',       // "with $expansion"

  // Variable references
  VAR_SIMPLE = 'VAR_SIMPLE',             // $VAR
  VAR_BRACED = 'VAR_BRACED',            // ${VAR}, ${VAR:-default}
  VAR_SPECIAL = 'VAR_SPECIAL',           // $?, $$, $!, $#, $@, $*, $0..$9

  // Substitutions
  CMD_SUB = 'CMD_SUB',                   // $(command)
  CMD_SUB_BACKTICK = 'CMD_SUB_BACKTICK', // `command`
  ARITH_SUB = 'ARITH_SUB',              // $((expression))

  // Operators
  PIPE = 'PIPE',                         // |
  AND_IF = 'AND_IF',                     // &&
  OR_IF = 'OR_IF',                       // ||
  SEMI = 'SEMI',                         // ;
  DSEMI = 'DSEMI',                       // ;;
  AMP = 'AMP',                           // &
  NEWLINE = 'NEWLINE',                   // \n

  // Redirections
  LESS = 'LESS',                         // <
  GREAT = 'GREAT',                       // >
  DGREAT = 'DGREAT',                     // >>
  LESSAND = 'LESSAND',                   // <&
  GREATAND = 'GREATAND',                 // >&
  FD_GREAT = 'FD_GREAT',                // 2>
  FD_DGREAT = 'FD_DGREAT',              // 2>>
  HEREDOC = 'HEREDOC',                   // <<
  HERESTRING = 'HERESTRING',             // <<<

  // Grouping
  LPAREN = 'LPAREN',                     // (
  RPAREN = 'RPAREN',                     // )
  LBRACE = 'LBRACE',                     // {
  RBRACE = 'RBRACE',                     // }

  // Test brackets
  LBRACKET = 'LBRACKET',                 // [
  RBRACKET = 'RBRACKET',                 // ]
  DLBRACKET = 'DLBRACKET',              // [[
  DRBRACKET = 'DRBRACKET',              // ]]

  // End of input
  EOF = 'EOF',
}

// ─── Reserved Keywords ──────────────────────────────────────────────

export const BASH_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'for', 'in', 'do', 'done',
  'while', 'until',
  'case', 'esac',
  'function', 'select', 'time',
]);

/** Map keyword string → token type. Returns WORD if not a keyword. */
export function keywordType(word: string): TokenType {
  return BASH_KEYWORDS.has(word) ? TokenType.WORD : TokenType.WORD;
}

// ─── Source Position ────────────────────────────────────────────────

export interface SourcePosition {
  offset: number;   // 0-based character offset
  line: number;     // 1-based line number
  column: number;   // 1-based column number
}

// ─── Token ──────────────────────────────────────────────────────────

export interface Token {
  type: TokenType;
  value: string;
  position: SourcePosition;
}

/** Create a token (convenience factory). */
export function token(type: TokenType, value: string, position: SourcePosition): Token {
  return { type, value, position };
}
