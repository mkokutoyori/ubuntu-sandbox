/**
 * SQL Parser, Engine, and Database Interface Tests
 *
 * Comprehensive tests for:
 * - SQL Lexer and Parser
 * - SQL Engine (CREATE, INSERT, SELECT, UPDATE, DELETE, etc.)
 * - PostgreSQL psql interface
 * - Oracle SQL*Plus interface
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenizeSQL, SQLTokenType } from '../terminal/sql/generic/lexer';
import { parseSQL } from '../terminal/sql/generic/parser';
import { SQLEngine } from '../terminal/sql/generic/engine';

// ============================================
// SQL Lexer Tests
// ============================================
describe('SQL Lexer', () => {
  it('tokenizes SELECT keyword', () => {
    const tokens = tokenizeSQL('SELECT');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].type).toBe(SQLTokenType.SELECT);
  });

  it('tokenizes CREATE TABLE keywords', () => {
    const tokens = tokenizeSQL('CREATE TABLE');
    expect(tokens.some(t => t.type === SQLTokenType.CREATE)).toBe(true);
    expect(tokens.some(t => t.type === SQLTokenType.TABLE)).toBe(true);
  });

  it('tokenizes identifiers', () => {
    const tokens = tokenizeSQL('SELECT name FROM users');
    expect(tokens.some(t => t.type === SQLTokenType.IDENTIFIER && t.value === 'name')).toBe(true);
    expect(tokens.some(t => t.type === SQLTokenType.IDENTIFIER && t.value === 'users')).toBe(true);
  });

  it('tokenizes string literals', () => {
    const tokens = tokenizeSQL("INSERT INTO t VALUES ('hello')");
    expect(tokens.some(t => t.type === SQLTokenType.STRING_LITERAL && t.value === 'hello')).toBe(true);
  });

  it('tokenizes number literals', () => {
    const tokens = tokenizeSQL('SELECT * FROM t WHERE id = 42');
    expect(tokens.some(t => t.type === SQLTokenType.NUMBER_LITERAL && t.value === '42')).toBe(true);
  });

  it('tokenizes operators', () => {
    const tokens = tokenizeSQL('SELECT * FROM t WHERE a = 1 AND b > 2');
    expect(tokens.some(t => t.type === SQLTokenType.EQUAL)).toBe(true);
    expect(tokens.some(t => t.type === SQLTokenType.GREATER_THAN)).toBe(true);
    expect(tokens.some(t => t.type === SQLTokenType.AND)).toBe(true);
  });

  it('tokenizes data types', () => {
    const tokens = tokenizeSQL('CREATE TABLE t (id INTEGER, name VARCHAR(100))');
    expect(tokens.some(t => t.type === SQLTokenType.INTEGER)).toBe(true);
    expect(tokens.some(t => t.type === SQLTokenType.VARCHAR)).toBe(true);
  });

  it('tokenizes PostgreSQL-specific types as identifiers', () => {
    const tokens = tokenizeSQL('CREATE TABLE t (id SERIAL)');
    // SERIAL is not a keyword, should be tokenized as identifier
    expect(tokens.some(t => t.type === SQLTokenType.IDENTIFIER && t.value.toUpperCase() === 'SERIAL')).toBe(true);
  });
});

// ============================================
// SQL Parser Tests
// ============================================
describe('SQL Parser', () => {
  describe('SELECT statements', () => {
    it('parses simple SELECT', () => {
      const result = parseSQL('SELECT * FROM users;');
      expect(result.success).toBe(true);
      expect(result.statements.length).toBe(1);
      expect(result.statements[0].type).toBe('SELECT');
    });

    it('parses SELECT with columns', () => {
      const result = parseSQL('SELECT id, name, email FROM users;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns.length).toBe(3);
    });

    it('parses SELECT with WHERE clause', () => {
      const result = parseSQL('SELECT * FROM users WHERE id = 1;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.where).toBeDefined();
    });

    it('parses SELECT with ORDER BY', () => {
      const result = parseSQL('SELECT * FROM users ORDER BY name DESC;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.orderBy).toBeDefined();
      expect(stmt.orderBy[0].direction).toBe('DESC');
    });

    it('parses SELECT with LIMIT', () => {
      const result = parseSQL('SELECT * FROM users LIMIT 10;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.limit).toBe(10);
    });

    it('parses SELECT DISTINCT', () => {
      const result = parseSQL('SELECT DISTINCT category FROM products;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.distinct).toBe(true);
    });
  });

  describe('INSERT statements', () => {
    it('parses simple INSERT', () => {
      const result = parseSQL("INSERT INTO users (name) VALUES ('John');");
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('INSERT');
    });

    it('parses INSERT with multiple columns', () => {
      const result = parseSQL("INSERT INTO users (name, email, age) VALUES ('John', 'john@example.com', 25);");
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns.length).toBe(3);
      expect(stmt.values[0].length).toBe(3);
    });
  });

  describe('UPDATE statements', () => {
    it('parses simple UPDATE', () => {
      const result = parseSQL("UPDATE users SET name = 'John';");
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('UPDATE');
    });

    it('parses UPDATE with WHERE', () => {
      const result = parseSQL("UPDATE users SET name = 'John' WHERE id = 1;");
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.where).toBeDefined();
    });
  });

  describe('DELETE statements', () => {
    it('parses simple DELETE', () => {
      const result = parseSQL('DELETE FROM users;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('DELETE');
    });

    it('parses DELETE with WHERE', () => {
      const result = parseSQL('DELETE FROM users WHERE id = 1;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.where).toBeDefined();
    });
  });

  describe('CREATE TABLE statements', () => {
    it('parses simple CREATE TABLE', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100));');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('CREATE_TABLE');
    });

    it('parses CREATE TABLE with PRIMARY KEY', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR(100));');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].primaryKey).toBe(true);
    });

    it('parses CREATE TABLE with NOT NULL', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER NOT NULL, name VARCHAR(100));');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].nullable).toBe(false);
    });

    it('parses CREATE TABLE with DEFAULT', () => {
      const result = parseSQL("CREATE TABLE users (id INTEGER, status VARCHAR(20) DEFAULT 'active');");
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[1].defaultValue).toBe('active');
    });

    it('parses CREATE TABLE IF NOT EXISTS', () => {
      const result = parseSQL('CREATE TABLE IF NOT EXISTS users (id INTEGER);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.ifNotExists).toBe(true);
    });

    it('parses CREATE TABLE with PostgreSQL SERIAL', () => {
      const result = parseSQL('CREATE TABLE users (id SERIAL PRIMARY KEY);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      // SERIAL is converted to INTEGER with autoIncrement: true
      expect(stmt.columns[0].dataType.toUpperCase()).toBe('INTEGER');
      expect(stmt.columns[0].autoIncrement).toBe(true);
    });

    it('parses CREATE TABLE with NUMERIC precision and scale', () => {
      const result = parseSQL('CREATE TABLE products (price NUMERIC(10,2));');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].precision).toBe(10);
      expect(stmt.columns[0].scale).toBe(2);
    });

    it('parses complex CREATE TABLE with multiple constraints', () => {
      const result = parseSQL(`
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          department VARCHAR(50),
          salary NUMERIC(10,2),
          hire_date DATE
        );
      `);
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns.length).toBe(5);
    });
  });

  describe('DROP statements', () => {
    it('parses DROP TABLE', () => {
      const result = parseSQL('DROP TABLE users;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('DROP_TABLE');
    });

    it('parses DROP TABLE IF EXISTS', () => {
      const result = parseSQL('DROP TABLE IF EXISTS users;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.ifExists).toBe(true);
    });

    it('parses DROP TABLE CASCADE', () => {
      const result = parseSQL('DROP TABLE users CASCADE;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.cascade).toBe(true);
    });
  });

  describe('Transaction statements', () => {
    it('parses BEGIN', () => {
      const result = parseSQL('BEGIN;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('BEGIN');
    });

    it('parses COMMIT', () => {
      const result = parseSQL('COMMIT;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('COMMIT');
    });

    it('parses ROLLBACK', () => {
      const result = parseSQL('ROLLBACK;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('ROLLBACK');
    });
  });

  describe('Other statements', () => {
    it('parses TRUNCATE', () => {
      const result = parseSQL('TRUNCATE TABLE users;');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('TRUNCATE');
    });

    it('parses CREATE INDEX', () => {
      const result = parseSQL('CREATE INDEX idx_name ON users(name);');
      expect(result.success).toBe(true);
      expect(result.statements[0].type).toBe('CREATE_INDEX');
    });

    it('parses CREATE UNIQUE INDEX', () => {
      const result = parseSQL('CREATE UNIQUE INDEX idx_email ON users(email);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.unique).toBe(true);
    });
  });
});

// ============================================
// SQL Engine Tests
// ============================================
describe('SQL Engine', () => {
  let engine: SQLEngine;

  beforeEach(() => {
    engine = new SQLEngine();
  });

  describe('CREATE TABLE', () => {
    it('creates a simple table', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100));');
      const execResult = engine.createTable(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('creates a table with PRIMARY KEY', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR(100));');
      const execResult = engine.createTable(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('fails to create duplicate table', () => {
      const result = parseSQL('CREATE TABLE users (id INTEGER);');
      engine.createTable(result.statements[0] as any);
      const execResult = engine.createTable(result.statements[0] as any);
      expect(execResult.success).toBe(false);
    });

    it('succeeds with IF NOT EXISTS on duplicate table', () => {
      const result1 = parseSQL('CREATE TABLE users (id INTEGER);');
      const result2 = parseSQL('CREATE TABLE IF NOT EXISTS users (id INTEGER);');
      engine.createTable(result1.statements[0] as any);
      const execResult = engine.createTable(result2.statements[0] as any);
      expect(execResult.success).toBe(true);
    });
  });

  describe('INSERT', () => {
    beforeEach(() => {
      const result = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100), age INTEGER);');
      engine.createTable(result.statements[0] as any);
    });

    it('inserts a row', () => {
      const result = parseSQL("INSERT INTO users (id, name, age) VALUES (1, 'John', 25);");
      const execResult = engine.executeInsert(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(1);
    });

    it('inserts multiple rows', () => {
      const result = parseSQL("INSERT INTO users (id, name, age) VALUES (1, 'John', 25), (2, 'Jane', 30);");
      const execResult = engine.executeInsert(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(2);
    });
  });

  describe('SELECT', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100), age INTEGER);');
      engine.createTable(create.statements[0] as any);
      const insert = parseSQL("INSERT INTO users (id, name, age) VALUES (1, 'John', 25), (2, 'Jane', 30), (3, 'Bob', 25);");
      engine.executeInsert(insert.statements[0] as any);
    });

    it('selects all rows', () => {
      const result = parseSQL('SELECT * FROM users;');
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(3);
    });

    it('selects specific columns', () => {
      const result = parseSQL('SELECT name, age FROM users;');
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.columns.length).toBe(2);
    });

    it('selects with WHERE clause', () => {
      const result = parseSQL('SELECT * FROM users WHERE age = 25;');
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(2);
    });

    it('selects with LIMIT', () => {
      const result = parseSQL('SELECT * FROM users LIMIT 2;');
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(2);
    });
  });

  describe('UPDATE', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100), age INTEGER);');
      engine.createTable(create.statements[0] as any);
      const insert = parseSQL("INSERT INTO users (id, name, age) VALUES (1, 'John', 25), (2, 'Jane', 30);");
      engine.executeInsert(insert.statements[0] as any);
    });

    it('updates all rows', () => {
      const result = parseSQL('UPDATE users SET age = 35;');
      const execResult = engine.executeUpdate(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(2);
    });

    it('updates with WHERE clause', () => {
      const result = parseSQL('UPDATE users SET age = 26 WHERE id = 1;');
      const execResult = engine.executeUpdate(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(1);
    });
  });

  describe('DELETE', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100));');
      engine.createTable(create.statements[0] as any);
      const insert = parseSQL("INSERT INTO users (id, name) VALUES (1, 'John'), (2, 'Jane');");
      engine.executeInsert(insert.statements[0] as any);
    });

    it('deletes all rows', () => {
      const result = parseSQL('DELETE FROM users;');
      const execResult = engine.executeDelete(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(2);
    });

    it('deletes with WHERE clause', () => {
      const result = parseSQL('DELETE FROM users WHERE id = 1;');
      const execResult = engine.executeDelete(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(1);
    });
  });

  describe('DROP TABLE', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE users (id INTEGER);');
      engine.createTable(create.statements[0] as any);
    });

    it('drops a table', () => {
      const result = engine.dropTable('users');
      expect(result.success).toBe(true);
    });

    it('fails to drop non-existent table', () => {
      const result = engine.dropTable('nonexistent');
      expect(result.success).toBe(false);
    });

    it('succeeds with IF EXISTS on non-existent table', () => {
      const result = engine.dropTable('nonexistent', undefined, true);
      expect(result.success).toBe(true);
    });
  });

  describe('Transactions', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE users (id INTEGER, name VARCHAR(100));');
      engine.createTable(create.statements[0] as any);
    });

    it('begins a transaction', () => {
      const result = engine.beginTransaction();
      expect(result.success).toBe(true);
    });

    it('commits a transaction', () => {
      engine.beginTransaction();
      const insert = parseSQL("INSERT INTO users (id, name) VALUES (1, 'John');");
      engine.executeInsert(insert.statements[0] as any);
      const result = engine.commit();
      expect(result.success).toBe(true);
    });

    it('rolls back a transaction', () => {
      engine.beginTransaction();
      const insert = parseSQL("INSERT INTO users (id, name) VALUES (1, 'John');");
      engine.executeInsert(insert.statements[0] as any);
      const result = engine.rollback();
      expect(result.success).toBe(true);
    });
  });
});
