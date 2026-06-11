/**
 * ROWNUM semantics (Oracle row-source model) and SQL*Plus output
 * fidelity: `no rows selected` for empty results and the real
 * `ERROR at line N:` error report with source echo + asterisk marker.
 */
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

function session(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

function withRows(name: string): SqlPlusSubShell {
  const sh = session(name);
  run(sh, 'CREATE TABLE t (x NUMBER);');
  for (const v of [10, 20, 30, 40, 50]) run(sh, `INSERT INTO t VALUES (${v});`);
  return sh;
}

describe('ROWNUM row-source semantics', () => {
  it('ROWNUM <= N limits to the first N rows', () => {
    const sh = withRows('rn1');
    const out = run(sh, 'SELECT x FROM t WHERE ROWNUM <= 2;');
    expect(out).toContain('10');
    expect(out).toContain('20');
    expect(out).not.toContain('30');
    sh.dispose();
  });

  it('ROWNUM > 1 returns no rows (counter only advances on accepted rows)', () => {
    const sh = withRows('rn2');
    expect(run(sh, 'SELECT x FROM t WHERE ROWNUM > 1;')).toContain('no rows selected');
    sh.dispose();
  });

  it('ROWNUM = 2 returns no rows', () => {
    const sh = withRows('rn3');
    expect(run(sh, 'SELECT x FROM t WHERE ROWNUM = 2;')).toContain('no rows selected');
    sh.dispose();
  });

  it('ROWNUM counts rows that pass the other predicates', () => {
    const sh = withRows('rn4');
    const out = run(sh, 'SELECT x FROM t WHERE x > 15 AND ROWNUM <= 2;');
    expect(out).toContain('20');
    expect(out).toContain('30');
    expect(out).not.toContain('40');
    sh.dispose();
  });

  it('ROWNUM is assigned before ORDER BY', () => {
    const sh = withRows('rn5');
    const out = run(sh, 'SELECT ROWNUM, x FROM t ORDER BY x DESC;');
    // First data row is x=50, which was read fifth: ROWNUM 5.
    const firstData = out.split('\n').find(l => /\b50\b/.test(l))!;
    expect(firstData.trim()).toMatch(/^5\s+50$/);
    sh.dispose();
  });
});

describe('SQL*Plus empty-result output', () => {
  it('prints "no rows selected" without a column header', () => {
    const sh = withRows('er1');
    const out = run(sh, 'SELECT x FROM t WHERE x > 999;');
    expect(out).toContain('no rows selected');
    expect(out).not.toMatch(/^\s*X\s*$/m);
    sh.dispose();
  });

  it('SET FEEDBACK OFF suppresses the message', () => {
    const sh = withRows('er2');
    run(sh, 'SET FEEDBACK OFF');
    expect(run(sh, 'SELECT x FROM t WHERE x > 999;')).not.toContain('no rows selected');
    sh.dispose();
  });
});

describe('SQL*Plus error report format', () => {
  it('echoes the statement, marks the column and prints ERROR at line N', () => {
    const sh = session('ef1');
    const out = run(sh, 'SELECT * FROM no_such_table;');
    const lines = out.split('\n');
    const echoIdx = lines.findIndex(l => l === 'SELECT * FROM no_such_table');
    expect(echoIdx).toBeGreaterThanOrEqual(0);
    expect(lines[echoIdx + 1]).toMatch(/^\s*\*$/);
    expect(lines[echoIdx + 2]).toBe('ERROR at line 1:');
    expect(lines[echoIdx + 3]).toContain('ORA-00942');
    sh.dispose();
  });

  it('non-ORA failures are wrapped as ORA-00900', () => {
    const sh = session('ef2');
    const out = run(sh, 'SELECT FROM WHERE;');
    expect(out).toContain('ERROR at line 1:');
    expect(out).toContain('ORA-009');
    sh.dispose();
  });
});
