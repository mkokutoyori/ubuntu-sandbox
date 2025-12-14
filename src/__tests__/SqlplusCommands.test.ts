/**
 * Oracle SQL*Plus Commands Tests (Minimal - to avoid memory issues)
 * Full tests are in SQLIntegration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { createSQLPlusSession, executeSQLPlus, getSQLPlusPrompt } from '../terminal/sql/oracle/sqlplus';

describe('Oracle SQL*Plus Commands', () => {
  // Create session once for all tests to reduce memory usage
  const session = createSQLPlusSession();

  describe('Basic Commands', () => {
    it('creates valid session', () => {
      expect(session).toBeDefined();
      expect(session.connected).toBe(true);
    });

    it('HELP shows help text', () => {
      const result = executeSQLPlus(session, 'HELP');
      expect(result.output).toBeDefined();
    });

    it('PROMPT displays text', () => {
      const result = executeSQLPlus(session, 'PROMPT Hello SQL*Plus');
      expect(result.output).toBe('Hello SQL*Plus');
    });

    it('shows SQL> prompt', () => {
      const prompt = getSQLPlusPrompt(session);
      expect(prompt).toContain('SQL');
    });
  });

  describe('SET/SHOW Commands', () => {
    it('SET LINESIZE works', () => {
      executeSQLPlus(session, 'SET LINESIZE 150');
      expect(session.settings.lineSize).toBe(150);
    });

    it('SET PAGESIZE works', () => {
      executeSQLPlus(session, 'SET PAGESIZE 30');
      expect(session.settings.pageSize).toBe(30);
    });

    it('SHOW ALL shows settings', () => {
      const result = executeSQLPlus(session, 'SHOW ALL');
      expect(result.output).toContain('linesize');
    });

    it('SHOW USER shows current user', () => {
      const result = executeSQLPlus(session, 'SHOW USER');
      expect(result.output).toContain('USER');
    });
  });

  describe('Table Operations', () => {
    it('creates and describes table', () => {
      const createResult = executeSQLPlus(session, 'CREATE TABLE sqlplus_test (id NUMBER PRIMARY KEY, name VARCHAR2(50));');
      expect(createResult.error).toBeUndefined();

      const descResult = executeSQLPlus(session, 'DESC sqlplus_test');
      expect(descResult.error).toBeUndefined();
      expect(descResult.output.toLowerCase()).toContain('name');
    });

    it('DESCRIBE non_existent shows error', () => {
      const result = executeSQLPlus(session, 'DESCRIBE non_existent_xyz');
      expect(result.error).toBeDefined();
    });
  });

  describe('Exit Commands', () => {
    it('DISCONNECT disconnects session', () => {
      const sessionCopy = createSQLPlusSession();
      executeSQLPlus(sessionCopy, 'DISCONNECT');
      expect(sessionCopy.connected).toBe(false);
    });

    it('EXIT returns exit flag', () => {
      const sessionCopy = createSQLPlusSession();
      const result = executeSQLPlus(sessionCopy, 'EXIT');
      expect(result.exit).toBe(true);
    });
  });
});
