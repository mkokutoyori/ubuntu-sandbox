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
export const TokenType = {
  // ── Literals ────────────────────────────────────────
  NUMBER_LITERAL: 'NUMBER_LITERAL',
  STRING_LITERAL: 'STRING_LITERAL',
  BIND_VARIABLE: 'BIND_VARIABLE',

  // ── Identifiers & Keywords ─────────────────────────
  IDENTIFIER: 'IDENTIFIER',
  QUOTED_IDENTIFIER: 'QUOTED_IDENTIFIER',
  KEYWORD: 'KEYWORD',

  // ── Operators ──────────────────────────────────────
  COMPARISON_OP: 'COMPARISON_OP',
  ARITHMETIC_OP: 'ARITHMETIC_OP',
  CONCAT_OP: 'CONCAT_OP',
  ASSIGN_OP: 'ASSIGN_OP',
  ASSOC_OP: 'ASSOC_OP',
  RANGE_OP: 'RANGE_OP',
  OUTER_JOIN_OP: 'OUTER_JOIN_OP',

  // ── Punctuation ────────────────────────────────────
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  COMMA: 'COMMA',
  SEMICOLON: 'SEMICOLON',
  DOT: 'DOT',
  STAR: 'STAR',
  AT: 'AT',
  COLON: 'COLON',
  PERCENT: 'PERCENT',

  // ── Special ────────────────────────────────────────
  LINE_COMMENT: 'LINE_COMMENT',
  BLOCK_COMMENT: 'BLOCK_COMMENT',
  HINT: 'HINT',
  SLASH: 'SLASH',
  WHITESPACE: 'WHITESPACE',
  NEWLINE: 'NEWLINE',
  EOF: 'EOF',
  UNKNOWN: 'UNKNOWN',

} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

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
