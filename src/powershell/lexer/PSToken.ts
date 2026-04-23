/**
 * PSToken — Token types and token structure for the PowerShell lexer.
 *
 * PowerShell 5.1 token model:
 *   - Case-insensitive keywords, case-preserving values
 *   - `$`-prefixed variables with optional scope qualifier (env:, script:, global:, local:)
 *   - `-Word` covers both cmdlet parameters (-Name) and comparison operators (-eq, -and)
 *   - `[TypeName]` type literals handled at lexer level
 *   - `@(...)` array expression, `@{...}` hashtable, `@'...'@` / `@"..."@` here-strings
 *   - `$(...)` subexpression operator
 */

// ─── Token Types ──────────────────────────────────────────────────────────────

export enum PSTokenType {
  // ── Identifiers & Literals ─────────────────────────────────────────────
  WORD            = 'WORD',           // cmdlet name, bareword, keyword
  NUMBER          = 'NUMBER',         // 123, 3.14, 0xFF, 1KB, 1MB, 1GB

  // ── String Literals ────────────────────────────────────────────────────
  STRING_SINGLE   = 'STRING_SINGLE',  // 'literal — no expansion'
  STRING_DOUBLE   = 'STRING_DOUBLE',  // "expandable $var"
  HEREDOC_SINGLE  = 'HEREDOC_SINGLE', // @'\n...\n'@  (no expansion)
  HEREDOC_DOUBLE  = 'HEREDOC_DOUBLE', // @"\n...\n"@  (expandable)

  // ── Variable References ────────────────────────────────────────────────
  VARIABLE        = 'VARIABLE',       // $name, $env:PATH, $script:x, $true, $false, $null
  SPLATTED        = 'SPLATTED',       // @varname  (splatting operator)

  // ── Subexpression / Array / Hashtable ──────────────────────────────────
  SUBEXPR         = 'SUBEXPR',        // $(...) — raw inner text stored in value

  // ── Cmdlet Parameters & Operators ─────────────────────────────────────
  // All -word tokens are PARAMETER; the parser/evaluator disambiguates
  // operator (-eq, -and, -not) vs named parameter (-Name, -Force).
  PARAMETER       = 'PARAMETER',      // -anyWord, value is the word (no leading dash)

  // ── Arithmetic Operators ───────────────────────────────────────────────
  PLUS            = 'PLUS',           // +
  MINUS           = 'MINUS',          // - (binary minus; negative literals use MINUS + NUMBER)
  MULTIPLY        = 'MULTIPLY',       // *
  DIVIDE          = 'DIVIDE',         // /
  MODULO          = 'MODULO',         // %

  // ── Assignment Operators ───────────────────────────────────────────────
  ASSIGN          = 'ASSIGN',         // =
  PLUS_ASSIGN     = 'PLUS_ASSIGN',    // +=
  MINUS_ASSIGN    = 'MINUS_ASSIGN',   // -=
  MULTIPLY_ASSIGN = 'MULTIPLY_ASSIGN',// *=
  DIVIDE_ASSIGN   = 'DIVIDE_ASSIGN',  // /=
  MODULO_ASSIGN   = 'MODULO_ASSIGN',  // %=

  // ── Member Access ──────────────────────────────────────────────────────
  DOT             = 'DOT',            // .  (instance member access)
  STATIC_MEMBER   = 'STATIC_MEMBER',  // :: (static / class member)
  RANGE           = 'RANGE',          // .. (range: 1..10)
  COMMA           = 'COMMA',          // ,

  // ── Increment / Decrement ─────────────────────────────────────────────
  INCREMENT       = 'INCREMENT',      // ++
  DECREMENT       = 'DECREMENT',      // --

  // ── Boolean Complement ─────────────────────────────────────────────────
  NOT             = 'NOT',            // ! (synonym for -not)

  // ── Type Literal ───────────────────────────────────────────────────────
  TYPE            = 'TYPE',           // [string], [int], [System.String[]]

  // ── Pipeline & Flow ────────────────────────────────────────────────────
  PIPE            = 'PIPE',           // |
  SEMICOLON       = 'SEMICOLON',      // ;
  NEWLINE         = 'NEWLINE',        // \n  (significant as statement terminator)
  AMPERSAND       = 'AMPERSAND',      // &  (call operator / background)

  // ── Grouping ───────────────────────────────────────────────────────────
  LPAREN          = 'LPAREN',         // (
  RPAREN          = 'RPAREN',         // )
  LBRACE          = 'LBRACE',         // {
  RBRACE          = 'RBRACE',         // }
  LBRACKET        = 'LBRACKET',       // [ (index operator, NOT type)
  RBRACKET        = 'RBRACKET',       // ]
  AT              = 'AT',             // @ (before ( or { for array/hashtable)

  // ── Redirections ────────────────────────────────────────────────────────
  REDIRECT_OUT         = 'REDIRECT_OUT',         // >
  REDIRECT_APPEND      = 'REDIRECT_APPEND',      // >>
  REDIRECT_ERR_OUT     = 'REDIRECT_ERR_OUT',     // 2>
  REDIRECT_ERR_APPEND  = 'REDIRECT_ERR_APPEND',  // 2>>
  REDIRECT_ALL_OUT     = 'REDIRECT_ALL_OUT',     // *>
  REDIRECT_ALL_APPEND  = 'REDIRECT_ALL_APPEND',  // *>>

  // ── End ────────────────────────────────────────────────────────────────
  EOF             = 'EOF',
}

// ─── Well-known Comparison / Logical Operators (PARAMETER tokens) ─────────────

/** PARAMETER token values that are PowerShell comparison operators. */
export const PS_COMPARISON_OPS = new Set([
  'eq', 'ne', 'gt', 'ge', 'lt', 'le',
  'ceq', 'cne', 'cgt', 'cge', 'clt', 'cle',   // case-sensitive variants
  'ieq', 'ine', 'igt', 'ige', 'ilt', 'ile',   // case-insensitive variants
  'like', 'notlike', 'clike', 'cnotlike', 'ilike', 'inotlike',
  'match', 'notmatch', 'cmatch', 'cnotmatch', 'imatch', 'inotmatch',
  'contains', 'notcontains', 'ccontains', 'cnotcontains',
  'in', 'notin',
  'is', 'isnot',
  'as',
]);

/** PARAMETER token values that are PowerShell logical operators. */
export const PS_LOGICAL_OPS = new Set(['and', 'or', 'xor', 'not']);

/** PARAMETER token values that are PowerShell string/collection operators. */
export const PS_STRING_OPS = new Set([
  'replace', 'creplace', 'ireplace',
  'split', 'csplit', 'isplit',
  'join',
  'f',
]);

/** PARAMETER token values that are PowerShell bitwise operators. */
export const PS_BITWISE_OPS = new Set(['band', 'bor', 'bxor', 'bnot', 'shl', 'shr']);

/** All PARAMETER values that are operators (not cmdlet switches). */
export const PS_OPERATOR_PARAMS = new Set([
  ...PS_COMPARISON_OPS,
  ...PS_LOGICAL_OPS,
  ...PS_STRING_OPS,
  ...PS_BITWISE_OPS,
]);

// ─── PowerShell Keywords ───────────────────────────────────────────────────────

/** Reserved keywords (case-insensitive in PowerShell, stored lowercase). */
export const PS_KEYWORDS = new Set([
  'if', 'elseif', 'else',
  'while', 'do', 'until', 'for', 'foreach', 'in',
  'switch', 'default',
  'try', 'catch', 'finally', 'throw', 'trap',
  'function', 'filter', 'workflow', 'configuration',
  'param', 'begin', 'process', 'end',
  'return', 'break', 'continue', 'exit',
  'class', 'enum', 'using', 'module',
  'data', 'dynamicparam',
  'hidden', 'static',
]);

// ─── Source Position ───────────────────────────────────────────────────────────

export interface SourcePosition {
  offset: number;   // 0-based character offset
  line: number;     // 1-based line number
  column: number;   // 1-based column number
}

// ─── Token ────────────────────────────────────────────────────────────────────

export interface PSToken {
  type: PSTokenType;
  value: string;
  position: SourcePosition;
}

/** Convenience factory. */
export function psToken(type: PSTokenType, value: string, position: SourcePosition): PSToken {
  return { type, value, position };
}
