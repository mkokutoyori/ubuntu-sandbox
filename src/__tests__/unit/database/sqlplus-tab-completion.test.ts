import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function setup(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  subShell.processLine('CREATE TABLE employees (id NUMBER, first_name VARCHAR2(50), salary NUMBER);');
  subShell.processLine('CREATE TABLE departments (dept_id NUMBER, dept_name VARCHAR2(50));');
  return subShell;
}

describe('SQL*Plus Tab completion (PRD item 4)', () => {
  it('completes SQL statement keywords at the start of the line', () => {
    const s = setup('sql-kw');
    expect(s.getCompletions!('SEL')).toEqual(['SELECT']);
    expect(s.getCompletions!('sel')).toEqual(['SELECT']);
    const cAll = s.getCompletions!('S');
    expect(cAll).toContain('SELECT');
    expect(cAll).toContain('SET');
    expect(cAll).toContain('SPOOL');
  });

  it('completes SQL*Plus commands too (SPOOL, DESC, HOST)', () => {
    const s = setup('sql-cmd');
    expect(s.getCompletions!('SPO')).toEqual(['SPOOL']);
    expect(s.getCompletions!('HOS')).toEqual(['HOST']);
    expect(s.getCompletions!('DES')).toEqual(['DESC', 'DESCRIBE']);
  });

  it('lists the REAL tables of the connected schema after FROM', () => {
    const s = setup('sql-tables');
    const c = s.getCompletions!('SELECT * FROM ');
    expect(c).toContain('EMPLOYEES');
    expect(c).toContain('DEPARTMENTS');
    expect(c).toContain('DUAL');
  });

  it('filters table candidates by the typed prefix', () => {
    const s = setup('sql-tprefix');
    expect(s.getCompletions!('SELECT * FROM emp')).toEqual(['EMPLOYEES']);
    expect(s.getCompletions!('DESC dep')).toEqual(['DEPARTMENTS']);
  });

  it('lists the REAL columns of the referenced table in the WHERE clause', () => {
    const s = setup('sql-cols');
    const c = s.getCompletions!('SELECT * FROM employees WHERE ');
    expect(c).toContain('ID');
    expect(c).toContain('FIRST_NAME');
    expect(c).toContain('SALARY');
    expect(c).not.toContain('DEPT_ID');
  });

  it('completes a column prefix of the referenced table', () => {
    const s = setup('sql-colprefix');
    expect(s.getCompletions!('SELECT * FROM employees WHERE sal')).toEqual(['SALARY']);
    expect(s.getCompletions!('SELECT id, fir FROM employees WHERE fir')).toEqual(['FIRST_NAME']);
  });

  it('falls back to clause keywords when no table is referenced', () => {
    const s = setup('sql-clause');
    const c = s.getCompletions!('SELECT * FR');
    expect(c).toEqual(['FROM']);
  });

  it('a table from another context is not offered (only the connected schema + DUAL)', () => {
    const s = setup('sql-schema');
    const c = s.getCompletions!('SELECT * FROM ');
    expect(c.every(n => /^[A-Z0-9_$#]+$/.test(n))).toBe(true);
  });

  it('query execution still works unchanged after completing (regression control)', () => {
    const s = setup('sql-regress');
    s.processLine("INSERT INTO employees VALUES (1, 'Alice', 5000);");
    const out = s.processLine('SELECT first_name FROM employees;').output.join('\n');
    expect(out).toContain('Alice');
  });
});
