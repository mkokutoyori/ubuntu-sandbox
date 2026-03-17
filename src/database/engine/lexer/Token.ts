/**
 * Token — Atomic lexical unit produced by a SQL lexer.
 *
 * Shared across all SQL dialects. Dialect-specific token types
 * are added in the dialect's enum extension.
 */

export interface SourcePosition {
  /** 0-based offset from the start of the input */
  offset: number;
  /** 1-based line number */
  line: number;
  /** 1-based column number */
  column: number;
}

export interface Token {
  /** Token classification */
  type: TokenType;
  /** Raw text exactly as it appeared in the source */
  value: string;
  /** Position in the source text */
  position: SourcePosition;
}

/**
 * Token types shared across all SQL dialects.
 *
 * Dialect-specific keywords (e.g., Oracle's ROWNUM, PG's ILIKE) are
 * tokenised as KEYWORD — the parser distinguishes them by value.
 */
export enum TokenType {
  // ── Literals ────────────────────────────────────────
  /** Numeric literal: 42, 3.14, 1.5e10 */
  NUMBER_LITERAL = 'NUMBER_LITERAL',
  /** Single-quoted string: 'hello', q'[it''s]' */
  STRING_LITERAL = 'STRING_LITERAL',
  /** Bind variable: :name, :1 */
  BIND_VARIABLE = 'BIND_VARIABLE',

  // ── Identifiers & Keywords ─────────────────────────
  /** Unquoted identifier: emp, department_id */
  IDENTIFIER = 'IDENTIFIER',
  /** Double-quoted identifier: "Column Name" */
  QUOTED_IDENTIFIER = 'QUOTED_IDENTIFIER',
  /** Reserved or non-reserved keyword: SELECT, FROM, etc. */
  KEYWORD = 'KEYWORD',

  // ── Operators ──────────────────────────────────────
  /** Comparison: =, <>, !=, <, >, <=, >= */
  COMPARISON_OP = 'COMPARISON_OP',
  /** Arithmetic: +, -, *, / */
  ARITHMETIC_OP = 'ARITHMETIC_OP',
  /** String concatenation: || */
  CONCAT_OP = 'CONCAT_OP',
  /** Assignment: := (PL/SQL) */
  ASSIGN_OP = 'ASSIGN_OP',
  /** Association: => (PL/SQL named params) */
  ASSOC_OP = 'ASSOC_OP',
  /** Range: .. (PL/SQL) */
  RANGE_OP = 'RANGE_OP',
  /** Oracle outer join: (+) — lexed as a single token when possible */
  OUTER_JOIN_OP = 'OUTER_JOIN_OP',

  // ── Punctuation ────────────────────────────────────
  /** Left parenthesis ( */
  LPAREN = 'LPAREN',
  /** Right parenthesis ) */
  RPAREN = 'RPAREN',
  /** Comma , */
  COMMA = 'COMMA',
  /** Semicolon ; — statement terminator */
  SEMICOLON = 'SEMICOLON',
  /** Dot . — schema.table, table.column */
  DOT = 'DOT',
  /** Star * — wildcard or multiplication (disambiguated by parser) */
  STAR = 'STAR',
  /** At sign @ — DB link, script execution */
  AT = 'AT',
  /** Colon : (PL/SQL labels, bind prefix) */
  COLON = 'COLON',
  /** Percent % — attribute: %TYPE, %ROWTYPE, %FOUND, etc. */
  PERCENT = 'PERCENT',

  // ── Special ────────────────────────────────────────
  /** Single-line comment: -- ... */
  LINE_COMMENT = 'LINE_COMMENT',
  /** Block comment: /* ... */ */
  BLOCK_COMMENT = 'BLOCK_COMMENT',
  /** SQL*Plus hint: /*+ ... */ */
  HINT = 'HINT',
  /** Forward slash / on its own line — execute PL/SQL block */
  SLASH = 'SLASH',
  /** Whitespace (typically skipped) */
  WHITESPACE = 'WHITESPACE',
  /** Newline (significant in SQL*Plus context) */
  NEWLINE = 'NEWLINE',
  /** End of input */
  EOF = 'EOF',
  /** Unknown / invalid character */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Set of SQL keywords shared by all dialects (SQL:2016 core).
 * Dialect-specific keywords are added by each lexer subclass.
 */
export const SQL_KEYWORDS = new Set([
  // DML
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
  'FROM', 'WHERE', 'SET', 'INTO', 'VALUES',
  // Clauses
  'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS',
  'NULL', 'TRUE', 'FALSE',
  'AS', 'ON', 'USING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'LIMIT', 'OFFSET', 'FETCH', 'NEXT', 'ONLY', 'ROWS', 'ROW', 'PERCENT', 'WITH', 'TIES',
  'DISTINCT', 'UNIQUE', 'ALL', 'ANY', 'SOME',
  // Joins
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  // Set operations
  'UNION', 'INTERSECT', 'EXCEPT',
  // DDL
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT',
  'TABLE', 'VIEW', 'INDEX', 'SEQUENCE', 'SCHEMA', 'DATABASE',
  'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CHECK', 'DEFAULT',
  'CASCADE', 'RESTRICT',
  'ADD', 'MODIFY', 'COLUMN',
  // DML extras
  'RETURNING', 'MATCHED',
  // Privileges
  'GRANT', 'REVOKE', 'TO', 'PUBLIC', 'IDENTIFIED',
  // Transaction
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'TRANSACTION',
  // Types
  'INTEGER', 'INT', 'SMALLINT', 'BIGINT', 'NUMERIC', 'DECIMAL',
  'FLOAT', 'REAL', 'DOUBLE', 'PRECISION',
  'CHAR', 'VARCHAR', 'CLOB', 'BLOB', 'BOOLEAN',
  'DATE', 'TIMESTAMP', 'INTERVAL',
  // Misc
  'IF', 'REPLACE', 'FORCE', 'NOFORCE', 'OR',
]);
