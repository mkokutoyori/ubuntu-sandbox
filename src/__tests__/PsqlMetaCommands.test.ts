/**
 * PostgreSQL psql Meta-Commands Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPsqlSession, executePsql, getPsqlPrompt, PsqlSession } from '../terminal/sql/postgres/psql';

describe('PostgreSQL psql Meta-Commands', () => {
  let session: PsqlSession;

  beforeEach(() => {
    session = createPsqlSession();
    // Create a simple test table
    executePsql(session, 'CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL, email VARCHAR(100));');
  });

  describe('Help Commands', () => {
    it('\\? shows help text', () => {
      const result = executePsql(session, '\\?');
      expect(result.output).toBeDefined();
      expect(result.output).toContain('General');
    });

    it('\\h shows SQL help overview', () => {
      const result = executePsql(session, '\\h');
      expect(result.output).toContain('SELECT');
    });

    it('\\h SELECT shows SELECT help', () => {
      const result = executePsql(session, '\\h SELECT');
      expect(result.output).toContain('SELECT');
    });
  });

  describe('Database Commands', () => {
    it('\\l lists databases', () => {
      const result = executePsql(session, '\\l');
      expect(result.output).toContain('Name');
    });

    it('\\conninfo shows connection info', () => {
      const result = executePsql(session, '\\conninfo');
      expect(result.output).toContain('connected');
    });

    it('\\c changes database', () => {
      const result = executePsql(session, '\\c testdb testuser');
      expect(result.output).toContain('connected');
    });
  });

  describe('Table Listing Commands', () => {
    it('\\dt lists tables', () => {
      const result = executePsql(session, '\\dt');
      expect(result.output).toContain('List of relations');
    });

    it('\\dt+ lists tables with extended info', () => {
      const result = executePsql(session, '\\dt+');
      expect(result.output).toContain('Size');
    });
  });

  describe('Table Description Commands', () => {
    it('\\d tablename describes a table', () => {
      const result = executePsql(session, '\\d users');
      expect(result.error).toBeUndefined();
      expect(result.output.toLowerCase()).toContain('column');
    });

    it('\\d non_existent_table shows error', () => {
      const result = executePsql(session, '\\d non_existent_table');
      expect(result.error).toBeDefined();
      expect(result.output).toContain('Did not find');
    });
  });

  describe('Schema and Role Commands', () => {
    it('\\dn lists schemas', () => {
      const result = executePsql(session, '\\dn');
      expect(result.output).toContain('List of schemas');
    });

    it('\\du lists roles', () => {
      const result = executePsql(session, '\\du');
      expect(result.output).toContain('List of roles');
    });

    it('\\df lists functions', () => {
      const result = executePsql(session, '\\df');
      expect(result.output).toContain('List of functions');
    });
  });

  describe('Display Mode Commands', () => {
    it('\\x toggles expanded display', () => {
      const result1 = executePsql(session, '\\x');
      expect(result1.output).toContain('Expanded display is on');
      const result2 = executePsql(session, '\\x');
      expect(result2.output).toContain('Expanded display is off');
    });

    it('\\a toggles aligned/unaligned output', () => {
      const result = executePsql(session, '\\a');
      expect(result.output).toContain('Output format');
    });

    it('\\t toggles tuples-only mode', () => {
      const result = executePsql(session, '\\t');
      expect(result.output).toContain('Tuples only');
    });

    it('\\timing toggles timing', () => {
      const result1 = executePsql(session, '\\timing');
      expect(result1.output).toContain('Timing is on');
      const result2 = executePsql(session, '\\timing');
      expect(result2.output).toContain('Timing is off');
    });
  });

  describe('Query Buffer Commands', () => {
    it('\\p prints empty buffer', () => {
      const result = executePsql(session, '\\p');
      expect(result.output).toContain('Query buffer is empty');
    });

    it('\\p prints buffered query', () => {
      executePsql(session, 'SELECT * FROM users');
      const result = executePsql(session, '\\p');
      expect(result.output).toContain('SELECT');
    });

    it('\\r clears buffer', () => {
      executePsql(session, 'SELECT * FROM users');
      executePsql(session, '\\r');
      const result = executePsql(session, '\\p');
      expect(result.output).toContain('Query buffer is empty');
    });
  });

  describe('pset Commands', () => {
    it('\\pset shows all settings', () => {
      const result = executePsql(session, '\\pset');
      expect(result.output).toContain('border');
      expect(result.output).toContain('format');
    });

    it('\\pset border changes border', () => {
      const result = executePsql(session, '\\pset border 2');
      expect(result.error).toBeUndefined();
    });
  });

  describe('Other Commands', () => {
    it('\\echo prints text', () => {
      const result = executePsql(session, '\\echo Hello World');
      expect(result.output).toBe('Hello World');
    });

    it('\\copyright shows copyright', () => {
      const result = executePsql(session, '\\copyright');
      expect(result.output).toContain('PostgreSQL');
    });

    it('\\q sets exit flag', () => {
      const result = executePsql(session, '\\q');
      expect(result.exit).toBe(true);
    });

    it('invalid command shows error', () => {
      const result = executePsql(session, '\\invalid_command');
      expect(result.error).toBeDefined();
    });
  });

  describe('Prompt Format', () => {
    it('shows database name in prompt', () => {
      const prompt = getPsqlPrompt(session);
      expect(prompt).toContain('postgres');
    });

    it('shows continuation prompt when buffer has content', () => {
      executePsql(session, 'SELECT *');
      const prompt = getPsqlPrompt(session);
      expect(prompt).toContain('-#');
    });
  });
});
