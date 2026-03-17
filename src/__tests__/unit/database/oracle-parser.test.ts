/**
 * Tests for OracleParser — parsing Oracle SQL into AST nodes.
 */

import { describe, it, expect } from 'vitest';
import { OracleLexer } from '@/database/oracle/OracleLexer';
import { OracleParser } from '@/database/oracle/OracleParser';
import { TokenType } from '@/database/engine/lexer/Token';

const lexer = new OracleLexer();

function parse(sql: string) {
  const tokens = lexer.tokenize(sql);
  const parser = new OracleParser();
  return parser.parse(tokens);
}

function parseMultiple(sql: string) {
  const tokens = lexer.tokenize(sql);
  const parser = new OracleParser();
  return parser.parseMultiple(tokens);
}

describe('OracleParser', () => {
  describe('SELECT statements', () => {
    it('parses SELECT 1 FROM DUAL', () => {
      const stmt = parse('SELECT 1 FROM DUAL');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns.length).toBe(1);
      expect(stmt.from?.length).toBe(1);
    });

    it('parses SELECT with alias', () => {
      const stmt = parse('SELECT 1 AS num FROM DUAL');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].alias).toBe('num');
    });

    it('parses SELECT *', () => {
      const stmt = parse('SELECT * FROM employees');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].expr.type).toBe('Star');
    });

    it('parses WHERE clause', () => {
      const stmt = parse('SELECT * FROM emp WHERE salary > 5000');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.where).toBeDefined();
      expect(stmt.where?.type).toBe('BinaryExpr');
    });

    it('parses ORDER BY', () => {
      const stmt = parse('SELECT * FROM emp ORDER BY salary DESC');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.orderBy?.length).toBe(1);
      expect(stmt.orderBy?.[0].direction).toBe('DESC');
    });

    it('parses GROUP BY with HAVING', () => {
      const stmt = parse('SELECT dept_id, COUNT(*) FROM emp GROUP BY dept_id HAVING COUNT(*) > 5');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.groupBy?.length).toBe(1);
      expect(stmt.having).toBeDefined();
    });

    it('parses JOINs', () => {
      const stmt = parse('SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.from?.length).toBe(1);
      expect(stmt.joins?.length).toBe(1);
      // JOIN without qualifier is INNER by default
      expect(stmt.joins?.[0].joinType).toBe('INNER');
    });

    it('parses DISTINCT', () => {
      const stmt = parse('SELECT DISTINCT dept_id FROM emp');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.distinct).toBe(true);
    });

    it('parses subquery in WHERE', () => {
      const stmt = parse('SELECT * FROM emp WHERE dept_id IN (SELECT id FROM dept)');
      expect(stmt.type).toBe('SelectStatement');
    });
  });

  describe('DML statements', () => {
    it('parses INSERT with VALUES', () => {
      const stmt = parse("INSERT INTO emp (id, name) VALUES (1, 'John')");
      expect(stmt.type).toBe('InsertStatement');
      if (stmt.type !== 'InsertStatement') return;
      expect(stmt.table.name).toBe('emp');
      expect(stmt.columns?.length).toBe(2);
    });

    it('parses UPDATE', () => {
      const stmt = parse("UPDATE emp SET salary = 5000 WHERE id = 1");
      expect(stmt.type).toBe('UpdateStatement');
      if (stmt.type !== 'UpdateStatement') return;
      expect(stmt.table.name).toBe('emp');
      expect(stmt.assignments.length).toBe(1);
    });

    it('parses DELETE', () => {
      const stmt = parse('DELETE FROM emp WHERE id = 1');
      expect(stmt.type).toBe('DeleteStatement');
      if (stmt.type !== 'DeleteStatement') return;
      expect(stmt.table.name).toBe('emp');
      expect(stmt.where).toBeDefined();
    });
  });

  describe('DDL statements', () => {
    it('parses CREATE TABLE', () => {
      const stmt = parse('CREATE TABLE test (id NUMBER(10) NOT NULL, name VARCHAR2(50))');
      expect(stmt.type).toBe('CreateTableStatement');
      if (stmt.type !== 'CreateTableStatement') return;
      expect(stmt.name).toBe('test');
      expect(stmt.columns.length).toBe(2);
    });

    it('parses DROP TABLE', () => {
      const stmt = parse('DROP TABLE emp');
      expect(stmt.type).toBe('DropTableStatement');
    });

    it('parses CREATE INDEX', () => {
      const stmt = parse('CREATE INDEX idx_emp_name ON emp (name)');
      expect(stmt.type).toBe('CreateIndexStatement');
    });

    it('parses CREATE SEQUENCE', () => {
      const stmt = parse('CREATE SEQUENCE emp_seq START WITH 1 INCREMENT BY 1');
      expect(stmt.type).toBe('CreateSequenceStatement');
    });

    it('parses TRUNCATE TABLE', () => {
      const stmt = parse('TRUNCATE TABLE emp');
      expect(stmt.type).toBe('TruncateTableStatement');
    });
  });

  describe('DCL statements', () => {
    it('parses GRANT', () => {
      const stmt = parse('GRANT SELECT, INSERT ON emp TO hr');
      expect(stmt.type).toBe('GrantStatement');
    });

    it('parses REVOKE', () => {
      const stmt = parse('REVOKE SELECT ON emp FROM hr');
      expect(stmt.type).toBe('RevokeStatement');
    });
  });

  describe('Oracle-specific syntax', () => {
    it('parses STARTUP', () => {
      const stmt = parse('STARTUP');
      expect(stmt.type).toBe('StartupStatement');
    });

    it('parses SHUTDOWN IMMEDIATE', () => {
      const stmt = parse('SHUTDOWN IMMEDIATE');
      expect(stmt.type).toBe('ShutdownStatement');
      if (stmt.type !== 'ShutdownStatement') return;
      expect(stmt.mode).toBe('IMMEDIATE');
    });

    it('parses ALTER SYSTEM SET', () => {
      const stmt = parse("ALTER SYSTEM SET open_cursors = 300");
      expect(stmt.type).toBe('AlterSystemStatement');
    });

    it('parses CREATE TABLESPACE', () => {
      const stmt = parse("CREATE TABLESPACE users DATAFILE '/u01/oradata/users01.dbf' SIZE 100M");
      expect(stmt.type).toBe('CreateTablespaceStatement');
    });
  });

  describe('Expressions', () => {
    it('parses function calls', () => {
      const stmt = parse("SELECT UPPER('hello') FROM DUAL");
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].expr.type).toBe('FunctionCall');
    });

    it('parses CASE expression', () => {
      const stmt = parse("SELECT CASE WHEN x > 1 THEN 'yes' ELSE 'no' END FROM DUAL");
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].expr.type).toBe('CaseExpr');
    });

    it('parses BETWEEN', () => {
      const stmt = parse('SELECT * FROM emp WHERE salary BETWEEN 3000 AND 5000');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.where?.type).toBe('BetweenExpr');
    });

    it('parses LIKE', () => {
      const stmt = parse("SELECT * FROM emp WHERE name LIKE 'J%'");
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.where?.type).toBe('LikeExpr');
    });

    it('parses IS NULL', () => {
      const stmt = parse('SELECT * FROM emp WHERE manager_id IS NULL');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.where?.type).toBe('IsNullExpr');
    });

    it('parses nested expressions', () => {
      const stmt = parse('SELECT (1 + 2) * 3 FROM DUAL');
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].expr.type).toBe('BinaryExpr');
    });

    it('parses DATE literal', () => {
      const stmt = parse("SELECT DATE '2024-01-15' FROM DUAL");
      expect(stmt.type).toBe('SelectStatement');
      if (stmt.type !== 'SelectStatement') return;
      expect(stmt.columns[0].expr.type).toBe('Literal');
    });
  });

  describe('Multiple statements', () => {
    it('parses semicolon-separated statements', () => {
      const stmts = parseMultiple('SELECT 1 FROM DUAL; SELECT 2 FROM DUAL');
      expect(stmts.length).toBe(2);
    });
  });
});
