/**
 * Fidelity regressions: ORDER BY NULLS FIRST/LAST handling and
 * ROLLBACK TO nonexistent savepoint (ORA-01086).
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
describe('ORDER BY null placement', () => {
  function setup(name: string): SqlPlusSubShell {
    const sh = session(name);
    run(sh, 'CREATE TABLE t (x NUMBER);');
    run(sh, 'INSERT INTO t VALUES (2);');
    run(sh, 'INSERT INTO t VALUES (NULL);');
    run(sh, 'INSERT INTO t VALUES (1);');
    return sh;
  }

  function ordered(out: string): string[] {
    // Keep only data lines: numbers or empty cells between header dashes and feedback.
    const lines = out.split('\n');
    const dashIdx = lines.findIndex(l => /^-+\s*$/.test(l.trim()));
    return lines
      .slice(dashIdx + 1)
      .filter(l => !/rows? selected/.test(l))
      .map(l => l.trim());
  }

  it('ASC puts NULL last by default (Oracle treats NULL as largest)', () => {
    const sh = setup('ob1');
    const vals = ordered(run(sh, 'SELECT x FROM t ORDER BY x;')).filter(v => v !== '');
    expect(vals.slice(0, 2)).toEqual(['1', '2']);
    sh.dispose();
  });

  it('DESC puts NULL first by default', () => {
    const sh = setup('ob2');
    const lines = ordered(run(sh, 'SELECT x FROM t ORDER BY x DESC;'));
    expect(lines[0]).toBe('');
    expect(lines.filter(v => v !== '').slice(0, 2)).toEqual(['2', '1']);
    sh.dispose();
  });

  it('NULLS FIRST overrides the ASC default', () => {
    const sh = setup('ob3');
    const lines = ordered(run(sh, 'SELECT x FROM t ORDER BY x NULLS FIRST;'));
    expect(lines[0]).toBe('');
    expect(lines.filter(v => v !== '').slice(0, 2)).toEqual(['1', '2']);
    sh.dispose();
  });

  it('NULLS LAST overrides the DESC default', () => {
    const sh = setup('ob4');
    const lines = ordered(run(sh, 'SELECT x FROM t ORDER BY x DESC NULLS LAST;')).filter(l => /^\d*$/.test(l));
    expect(lines.filter(v => v !== '').slice(0, 2)).toEqual(['2', '1']);
    expect(lines[lines.length - 1]).toBe('');
    sh.dispose();
  });
});

describe('ROLLBACK TO SAVEPOINT fidelity', () => {
  it('raises ORA-01086 for a savepoint never established', () => {
    const sh = session('sp1');
    run(sh, 'CREATE TABLE t (x NUMBER);');
    run(sh, 'INSERT INTO t VALUES (1);');
    const out = run(sh, 'ROLLBACK TO SAVEPOINT nope;');
    expect(out).toMatch(/ORA-01086/);
    sh.dispose();
  });

  it('still rolls back to an established savepoint', () => {
    const sh = session('sp2');
    run(sh, 'CREATE TABLE t (x NUMBER);');
    run(sh, 'INSERT INTO t VALUES (1);');
    run(sh, 'SAVEPOINT sp_a;');
    run(sh, 'INSERT INTO t VALUES (2);');
    const out = run(sh, 'ROLLBACK TO SAVEPOINT sp_a;');
    expect(out).not.toMatch(/ORA-/);
    expect(run(sh, 'SELECT COUNT(*) FROM t;')).toMatch(/1/);
    sh.dispose();
  });
});

describe('TRUNC(date, fmt) format coverage', () => {
  it('supports Q, IW, W, WW, HH24 and MI like real Oracle', () => {
    const sh = session('trunc1');
    const q = run(sh, "SELECT TRUNC(TO_DATE('2026-05-15','YYYY-MM-DD'), 'Q') FROM dual;");
    expect(q).toMatch(/2026-04-01/);
    // 2026-05-15 is a Friday; ISO week starts Monday 2026-05-11,
    // default week starts Sunday 2026-05-10.
    const iw = run(sh, "SELECT TRUNC(TO_DATE('2026-05-15','YYYY-MM-DD'), 'IW') FROM dual;");
    expect(iw).toMatch(/2026-05-11/);
    const day = run(sh, "SELECT TRUNC(TO_DATE('2026-05-15','YYYY-MM-DD'), 'DAY') FROM dual;");
    expect(day).toMatch(/2026-05-10/);
    const w = run(sh, "SELECT TRUNC(TO_DATE('2026-05-15','YYYY-MM-DD'), 'W') FROM dual;");
    expect(w).toMatch(/2026-05-15/);
    sh.dispose();
  });
});
