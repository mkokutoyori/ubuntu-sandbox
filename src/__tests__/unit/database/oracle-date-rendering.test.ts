/**
 * Default Oracle DATE rendering (rapport 07, item #48). A bare
 * `SELECT date_col FROM t` printed the internal `YYYY-MM-DD HH:MM:SS`
 * storage string verbatim (wrong format, and leaking the time-of-day
 * Oracle's default suppresses) instead of NLS_DATE_FORMAT's real default
 * `DD-MON-RR`. `NLS_DATE_FORMAT` was modeled per-session but neither
 * settable (`ALTER SESSION SET NLS_DATE_FORMAT` was a silent no-op) nor
 * consulted by rendering; `TO_CHAR(date)` with no format had the same bug
 * in miniature. The `RR` token itself (this codebase's own claimed
 * default format) was entirely unimplemented in the format/parse engine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function s(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
const run = (sh: ReturnType<typeof s>, q: string) => sh.processLine(q).output.join('\n');

describe('default (no TO_CHAR) DATE rendering uses DD-MON-RR, not the internal storage string', () => {
  it('a bare SELECT of a DATE column shows DD-MON-RR with no time component', () => {
    const sh = s('d1');
    run(sh, 'CREATE TABLE hr.t (id NUMBER, hire_date DATE);');
    run(sh, "INSERT INTO hr.t VALUES (1, DATE '2024-03-15');");
    const out = run(sh, 'SELECT hire_date FROM hr.t;');
    expect(out).toContain('15-MAR-24');
    expect(out).not.toContain('2024-03-15');
    expect(out).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('SELECT SYSDATE FROM DUAL renders DD-MON-RR, not a full timestamp', () => {
    const sh = s('d2');
    const out = run(sh, 'SELECT SYSDATE FROM DUAL;');
    expect(out).toMatch(/\d{2}-[A-Z]{3}-\d{2}/);
    expect(out).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('TO_CHAR(date_col) with no format mask matches the bare-SELECT default', () => {
    const sh = s('d3');
    run(sh, 'CREATE TABLE hr.t (id NUMBER, hire_date DATE);');
    run(sh, "INSERT INTO hr.t VALUES (1, DATE '2024-03-15');");
    const out = run(sh, 'SELECT TO_CHAR(hire_date) FROM hr.t;');
    expect(out).toContain('15-MAR-24');
  });

  it('an explicit TO_CHAR format mask still overrides the default', () => {
    const sh = s('d4');
    run(sh, 'CREATE TABLE hr.t (id NUMBER, hire_date DATE);');
    run(sh, "INSERT INTO hr.t VALUES (1, DATE '2024-03-15');");
    const out = run(sh, "SELECT TO_CHAR(hire_date, 'YYYY-MM-DD') FROM hr.t;");
    expect(out).toContain('2024-03-15');
  });
});

describe('ALTER SESSION SET NLS_DATE_FORMAT actually changes default rendering', () => {
  it('a new format takes effect for subsequent bare SELECTs', () => {
    const sh = s('d5');
    run(sh, 'CREATE TABLE hr.t (id NUMBER, hire_date DATE);');
    run(sh, "INSERT INTO hr.t VALUES (1, DATE '2024-03-15');");
    expect(run(sh, 'SELECT hire_date FROM hr.t;')).toContain('15-MAR-24');

    run(sh, "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY/MM/DD';");
    const out = run(sh, 'SELECT hire_date FROM hr.t;');
    expect(out).toContain('2024/03/15');
    expect(out).not.toContain('15-MAR-24');
  });

  it('is reported back by SYS_CONTEXT(USERENV, NLS_DATE_FORMAT) after the change', () => {
    const sh = s('d6');
    run(sh, "ALTER SESSION SET NLS_DATE_FORMAT = 'MM-DD-YYYY';");
    const out = run(sh, "SELECT SYS_CONTEXT('USERENV','NLS_DATE_FORMAT') FROM DUAL;");
    expect(out).toContain('MM-DD-YYYY');
  });
});

describe('RR format token (the default format\'s own year token)', () => {
  it('TO_CHAR formats RR identically to a 2-digit year', () => {
    const sh = s('d7');
    const out = run(sh, "SELECT TO_CHAR(DATE '2026-07-26', 'DD-MON-RR') FROM DUAL;");
    expect(out).toContain('26-JUL-26');
  });

  it('TO_DATE parses an RR-formatted string to the correct century, not year 2000', () => {
    const sh = s('d8');
    const out = run(sh, "SELECT TO_CHAR(TO_DATE('26-JUL-26','DD-MON-RR'), 'YYYY-MM-DD') FROM DUAL;");
    expect(out).toContain('2026-07-26');
    expect(out).not.toContain('2000-07-26');
  });
});
