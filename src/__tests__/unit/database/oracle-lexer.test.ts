/**
 * Tests for OracleLexer — tokenization of Oracle SQL.
 */

import { describe, it, expect } from 'vitest';
import { OracleLexer } from '@/database/oracle/OracleLexer';
import { TokenType } from '@/database/engine/lexer/Token';

const lexer = new OracleLexer();

/** Helper: tokenize and filter out EOF tokens */
function tokenize(sql: string, skipWs = true, skipComments = true) {
  return lexer.tokenize(sql, skipWs, skipComments).filter(t => t.type !== TokenType.EOF);
}

describe('OracleLexer', () => {
  it('tokenizes a simple SELECT statement', () => {
    const tokens = tokenize('SELECT 1 FROM DUAL');
    const types = tokens.map(t => t.type);
    expect(types).toEqual([
      TokenType.KEYWORD,        // SELECT
      TokenType.NUMBER_LITERAL, // 1
      TokenType.KEYWORD,        // FROM
      TokenType.KEYWORD,        // DUAL (Oracle keyword)
    ]);
  });

  it('tokenizes string literals', () => {
    const tokens = tokenize("SELECT 'hello world' FROM DUAL");
    expect(tokens[1].type).toBe(TokenType.STRING_LITERAL);
    expect(tokens[1].value).toBe("'hello world'");
  });

  it('tokenizes numbers with decimals', () => {
    const tokens = tokenize('SELECT 3.14, 42, .5 FROM DUAL');
    expect(tokens.filter(t => t.type === TokenType.NUMBER_LITERAL).length).toBe(3);
    expect(tokens[1].value).toBe('3.14');
  });

  it('tokenizes comparison operators', () => {
    const tokens = tokenize('SELECT * FROM t WHERE a >= 1 AND b <> 2 AND c != 3');
    const ops = tokens.filter(t => t.type === TokenType.COMPARISON_OP);
    expect(ops.map(o => o.value)).toEqual(['>=', '<>', '!=']);
  });

  it('tokenizes Oracle concatenation operator ||', () => {
    const tokens = tokenize("SELECT 'a' || 'b' FROM DUAL");
    expect(tokens.find(t => t.value === '||')?.type).toBe(TokenType.CONCAT_OP);
  });

  it('tokenizes quoted identifiers', () => {
    const tokens = tokenize('SELECT "My Column" FROM "My Table"');
    expect(tokens[1].type).toBe(TokenType.QUOTED_IDENTIFIER);
    expect(tokens[1].value).toBe('"My Column"');
  });

  it('tokenizes bind variables', () => {
    const tokens = tokenize('SELECT :id, :name FROM t');
    const binds = tokens.filter(t => t.type === TokenType.BIND_VARIABLE);
    expect(binds.map(b => b.value)).toEqual([':id', ':name']);
  });

  it('skips single-line comments', () => {
    const tokens = tokenize('SELECT 1 -- comment\nFROM DUAL');
    expect(tokens.map(t => t.value.toUpperCase())).toEqual(['SELECT', '1', 'FROM', 'DUAL']);
  });

  it('skips block comments', () => {
    const tokens = tokenize('SELECT /* comment */ 1 FROM DUAL');
    expect(tokens.map(t => t.value.toUpperCase())).toEqual(['SELECT', '1', 'FROM', 'DUAL']);
  });

  it('tokenizes Oracle hints', () => {
    const tokens = lexer.tokenize('SELECT /*+ FULL(t) */ * FROM t', false, false)
      .filter(t => t.type !== TokenType.EOF);
    const hint = tokens.find(t => t.type === TokenType.HINT);
    expect(hint).toBeDefined();
    expect(hint?.value).toContain('FULL(t)');
  });

  it('recognizes Oracle-specific keywords', () => {
    const tokens = tokenize('SELECT SYSDATE, ROWNUM, NVL(a, b) FROM DUAL');
    const keywords = tokens.filter(t => t.type === TokenType.KEYWORD);
    expect(keywords.map(k => k.value.toUpperCase())).toContain('SYSDATE');
    expect(keywords.map(k => k.value.toUpperCase())).toContain('ROWNUM');
    expect(keywords.map(k => k.value.toUpperCase())).toContain('NVL');
    expect(keywords.map(k => k.value.toUpperCase())).toContain('DUAL');
  });

  it('tokenizes multi-char punctuation', () => {
    const tokens = tokenize('a := b => c .. d');
    expect(tokens.find(t => t.value === ':=')?.type).toBe(TokenType.ASSIGN_OP);
    expect(tokens.find(t => t.value === '=>')?.type).toBe(TokenType.ASSOC_OP);
    expect(tokens.find(t => t.value === '..')?.type).toBe(TokenType.RANGE_OP);
  });

  it('tracks source positions', () => {
    const tokens = tokenize('SELECT\n  1');
    expect(tokens[0].position.line).toBe(1);
    expect(tokens[0].position.column).toBe(1);
    // Second token is on line 2
    const numToken = tokens.find(t => t.type === TokenType.NUMBER_LITERAL);
    expect(numToken?.position.line).toBe(2);
  });

  it('tokenizes empty input', () => {
    const tokens = tokenize('');
    expect(tokens.length).toBe(0);
  });

  it('tokenizes parentheses and commas', () => {
    const tokens = tokenize('(a, b)');
    expect(tokens[0].type).toBe(TokenType.LPAREN);
    expect(tokens[2].type).toBe(TokenType.COMMA);
    expect(tokens[4].type).toBe(TokenType.RPAREN);
  });
});
