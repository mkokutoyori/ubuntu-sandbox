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
const run = async (sh: ReturnType<typeof s>, q: string) => (await sh.processLine(q)).output.join('\n');

describe('FLASHBACK / PURGE statements parse', () => {
  it("FLASHBACK DATABASE TO TIMESTAMP / SCN", async () => {
    const sh = s('fb-db');
    expect((await run(sh, "FLASHBACK DATABASE TO TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR;")))
      .not.toMatch(/SP2-/);
    expect((await run(sh, "FLASHBACK DATABASE TO SCN 1900000;"))).not.toMatch(/SP2-/);
    sh.dispose();
  });

  it('FLASHBACK TABLE … TO TIMESTAMP / BEFORE DROP', async () => {
    const sh = s('fb-tab');
    expect((await run(sh, "FLASHBACK TABLE hr.employees TO TIMESTAMP SYSTIMESTAMP - INTERVAL '30' MINUTE;")))
      .not.toMatch(/SP2-/);
    expect((await run(sh, 'FLASHBACK TABLE hr.employees TO BEFORE DROP;'))).not.toMatch(/SP2-/);
    sh.dispose();
  });

  it('PURGE RECYCLEBIN / DBA_RECYCLEBIN', async () => {
    const sh = s('purge');
    expect((await run(sh, 'PURGE RECYCLEBIN;'))).not.toMatch(/SP2-/);
    expect((await run(sh, 'PURGE DBA_RECYCLEBIN;'))).not.toMatch(/SP2-/);
    sh.dispose();
  });
});

describe('ALTER TABLE / INDEX LOGGING/NOLOGGING', () => {
  it('ALTER TABLE … LOGGING / NOLOGGING / FORCE LOGGING', async () => {
    const sh = s('tlog');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER);'));
    expect((await run(sh, 'ALTER TABLE hr.t LOGGING;'))).toMatch(/Table altered/i);
    expect((await run(sh, 'ALTER TABLE hr.t NOLOGGING;'))).toMatch(/Table altered/i);
    sh.dispose();
  });

  it('ALTER INDEX … LOGGING / NOLOGGING', async () => {
    const sh = s('ilog');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY);'));
    (await run(sh, 'CREATE INDEX hr.i ON hr.t (id);'));
    expect((await run(sh, 'ALTER INDEX hr.i LOGGING;'))).toMatch(/Index altered/i);
    expect((await run(sh, 'ALTER INDEX hr.i NOLOGGING;'))).toMatch(/Index altered/i);
    sh.dispose();
  });
});

describe('V$DATABASE control-file metadata', () => {
  it('CONTROLFILE_CHANGE# / CONTROLFILE_TIME / CONTROLFILE_SEQUENCE# present', async () => {
    const sh = s('cfmd');
    const out = (await run(sh,
      'SELECT controlfile_type, controlfile_change#, controlfile_time, controlfile_sequence# FROM v$database;'
    ));
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('Missing views — empty by default but parseable', () => {
  it.each(['FGA_LOG$', 'V$UNDOSTAT', 'V$ROLLSTAT', 'V$ROLLNAME'])
    ('SELECT * FROM %s does not throw ORA-00942', async (view) => {
    const sh = s(`v-${view}`);
    const escaped = view.replace('$', '\\$');
    const out = (await run(sh, `SELECT * FROM ${view};`));
    expect(out, `failed for ${escaped}`).not.toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('V$PROCESS column extensions', () => {
  it('exposes a STATUS column', async () => {
    const sh = s('vproc');
    const out = (await run(sh, "SELECT pname, status FROM v$process WHERE pname LIKE 'LGWR%' OR pname LIKE 'ARC%';"));
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});
