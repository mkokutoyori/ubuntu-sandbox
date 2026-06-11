/**
 * Sequence session semantics: NEXTVAL advances one GLOBAL counter, but
 * CURRVAL is the last NEXTVAL obtained BY THIS SESSION (Oracle SQL
 * Language Reference, "Pseudocolumns"). Another session's NEXTVAL must
 * never change what this session's CURRVAL returns.
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

function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('sequence NEXTVAL/CURRVAL session scoping', () => {
  it('CURRVAL is per-session while NEXTVAL advances the global counter', () => {
    const srv = new LinuxServer('linux-server', 'seq-host', 100, 100);
    const a = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const b = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;

    run(a, 'CREATE SEQUENCE s;');
    expect(run(a, 'SELECT s.NEXTVAL FROM dual;')).toMatch(/\b1\b/);
    // Session B draws the next global value…
    expect(run(b, 'SELECT s.NEXTVAL FROM dual;')).toMatch(/\b2\b/);
    // …but session A's CURRVAL must still be ITS last value.
    expect(run(a, 'SELECT s.CURRVAL FROM dual;')).toMatch(/\b1\b/);
    expect(run(b, 'SELECT s.CURRVAL FROM dual;')).toMatch(/\b2\b/);

    a.dispose(); b.dispose();
  });

  it('CURRVAL before any NEXTVAL in the session raises ORA-08002', () => {
    const srv = new LinuxServer('linux-server', 'seq-host2', 100, 100);
    const a = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const c = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    run(a, 'CREATE SEQUENCE s;');
    run(a, 'SELECT s.NEXTVAL FROM dual;');
    // Fresh session: the global counter is 1, but THIS session never
    // called NEXTVAL.
    expect(run(c, 'SELECT s.CURRVAL FROM dual;')).toContain('ORA-08002');
    a.dispose(); c.dispose();
  });

  it('NEXTVAL/CURRVAL on a missing sequence raises ORA-02289', () => {
    const srv = new LinuxServer('linux-server', 'seq-host3', 100, 100);
    const a = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    expect(run(a, 'SELECT nope.NEXTVAL FROM dual;')).toContain('ORA-02289');
    expect(run(a, 'SELECT nope.CURRVAL FROM dual;')).toContain('ORA-02289');
    a.dispose();
  });

  it('CURRVAL after DROP SEQUENCE raises ORA-02289, not the stale value', () => {
    const srv = new LinuxServer('linux-server', 'seq-host4', 100, 100);
    const a = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    run(a, 'CREATE SEQUENCE s;');
    run(a, 'SELECT s.NEXTVAL FROM dual;');
    run(a, 'DROP SEQUENCE s;');
    expect(run(a, 'SELECT s.CURRVAL FROM dual;')).toContain('ORA-02289');
    a.dispose();
  });
});
