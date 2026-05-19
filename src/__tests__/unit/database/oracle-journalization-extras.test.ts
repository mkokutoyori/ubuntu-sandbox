/**
 * Remaining journalisation gaps after the first pass:
 * FLASHBACK DATABASE/TABLE, PURGE RECYCLEBIN, ALTER TABLE/INDEX
 * LOGGING/NOLOGGING, V\$DATABASE control-file metadata, FGA_LOG\$,
 * V\$UNDOSTAT/V\$ROLLSTAT/V\$ROLLNAME, V\$PROCESS.STATUS.
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

function s(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
const run = (sh: ReturnType<typeof s>, q: string) => sh.processLine(q).output.join('\n');

describe('FLASHBACK / PURGE statements parse', () => {
  it("FLASHBACK DATABASE TO TIMESTAMP / SCN", () => {
    const sh = s('fb-db');
    expect(run(sh, "FLASHBACK DATABASE TO TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR;"))
      .not.toMatch(/SP2-/);
    expect(run(sh, "FLASHBACK DATABASE TO SCN 1900000;")).not.toMatch(/SP2-/);
    sh.dispose();
  });

  it('FLASHBACK TABLE … TO TIMESTAMP / BEFORE DROP', () => {
    const sh = s('fb-tab');
    expect(run(sh, "FLASHBACK TABLE hr.employees TO TIMESTAMP SYSTIMESTAMP - INTERVAL '30' MINUTE;"))
      .not.toMatch(/SP2-/);
    expect(run(sh, 'FLASHBACK TABLE hr.employees TO BEFORE DROP;')).not.toMatch(/SP2-/);
    sh.dispose();
  });

  it('PURGE RECYCLEBIN / DBA_RECYCLEBIN', () => {
    const sh = s('purge');
    expect(run(sh, 'PURGE RECYCLEBIN;')).not.toMatch(/SP2-/);
    expect(run(sh, 'PURGE DBA_RECYCLEBIN;')).not.toMatch(/SP2-/);
    sh.dispose();
  });
});

describe('ALTER TABLE / INDEX LOGGING/NOLOGGING', () => {
  it('ALTER TABLE … LOGGING / NOLOGGING / FORCE LOGGING', () => {
    const sh = s('tlog');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'ALTER TABLE hr.t LOGGING;')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.t NOLOGGING;')).toMatch(/Table altered/i);
    sh.dispose();
  });

  it('ALTER INDEX … LOGGING / NOLOGGING', () => {
    const sh = s('ilog');
    run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY);');
    run(sh, 'CREATE INDEX hr.i ON hr.t (id);');
    expect(run(sh, 'ALTER INDEX hr.i LOGGING;')).toMatch(/Index altered/i);
    expect(run(sh, 'ALTER INDEX hr.i NOLOGGING;')).toMatch(/Index altered/i);
    sh.dispose();
  });
});

describe('V$DATABASE control-file metadata', () => {
  it('CONTROLFILE_CHANGE# / CONTROLFILE_TIME / CONTROLFILE_SEQUENCE# present', () => {
    const sh = s('cfmd');
    const out = run(sh,
      'SELECT controlfile_type, controlfile_change#, controlfile_time, controlfile_sequence# FROM v$database;'
    );
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('Missing views — empty by default but parseable', () => {
  it.each(['FGA_LOG$', 'V$UNDOSTAT', 'V$ROLLSTAT', 'V$ROLLNAME'])
    ('SELECT * FROM %s does not throw ORA-00942', (view) => {
    const sh = s(`v-${view}`);
    const escaped = view.replace('$', '\\$');
    const out = run(sh, `SELECT * FROM ${view};`);
    expect(out, `failed for ${escaped}`).not.toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('V$PROCESS column extensions', () => {
  it('exposes a STATUS column', () => {
    const sh = s('vproc');
    const out = run(sh, "SELECT pname, status FROM v$process WHERE pname LIKE 'LGWR%' OR pname LIKE 'ARC%';");
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});
