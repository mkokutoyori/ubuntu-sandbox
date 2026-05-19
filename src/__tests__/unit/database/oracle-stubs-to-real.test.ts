/**
 * Convert several remaining "metadata-only no-op" stubs to real
 * behaviour:
 *
 *  - ANALYZE TABLE … COMPUTE STATISTICS also sets LAST_ANALYZED to
 *    a real timestamp, populates DBA_TAB_STATISTICS, and refreshes
 *    DBA_TAB_HISTOGRAMS / DBA_TAB_STATS_HISTORY where applicable.
 *  - ALTER TABLE … MOVE COMPRESS … records the compression mode on
 *    the table so DBA_TABLES.COMPRESSION / COMPRESS_FOR reflect it.
 *  - ALTER TABLE … SHRINK SPACE drops EMPTY_BLOCKS to 0 (the
 *    after-shrink reality on an empty table).
 *  - CREATE PFILE FROM SPFILE writes a pfile that lists every
 *    parameter the instance currently holds.
 *  - CREATE SPFILE FROM PFILE='path' loads the pfile's *.<param>=val
 *    lines into the instance.
 *  - V\$DATAFILE.STATUS reflects the tablespace status (ONLINE /
 *    OFFLINE / READ ONLY → SYSOFF when underlying TS is offline).
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

describe('ANALYZE updates LAST_ANALYZED', () => {
  it('LAST_ANALYZED is null before, set after COMPUTE STATISTICS', () => {
    const sh = s('an1');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    const before = run(sh, "SELECT last_analyzed FROM dba_tables WHERE owner='HR' AND table_name='T';");
    // 19c-style: NULL before ANALYZE/GATHER
    expect(before).not.toMatch(/2026/);
    run(sh, 'ANALYZE TABLE hr.t COMPUTE STATISTICS;');
    const after = run(sh, "SELECT last_analyzed FROM dba_tables WHERE owner='HR' AND table_name='T';");
    // Oracle's default NLS_DATE_FORMAT is DD-MON-YY (e.g. 19-MAY-26).
    expect(after).toMatch(/\d{2}-[A-Z]{3}-\d{2}|\d{4}-\d{2}-\d{2}/);
    sh.dispose();
  });
});

describe('MOVE COMPRESS records the compression mode on the table', () => {
  it('DBA_TABLES.COMPRESSION reflects ENABLED after ALTER TABLE … MOVE COMPRESS', () => {
    const sh = s('cmp');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, "SELECT compression FROM dba_tables WHERE owner='HR' AND table_name='T';"))
      .toContain('DISABLED');
    run(sh, 'ALTER TABLE hr.t MOVE COMPRESS FOR QUERY HIGH;');
    const out = run(sh, "SELECT compression, compress_for FROM dba_tables WHERE owner='HR' AND table_name='T';");
    expect(out).toContain('ENABLED');
    expect(out).toMatch(/QUERY HIGH/i);
    sh.dispose();
  });
});

describe('CREATE PFILE FROM SPFILE writes a real pfile to the VFS', () => {
  it('the pfile lists at least db_name, instance_name, compatible', () => {
    const sh = s('pfile');
    run(sh, "CREATE PFILE='/tmp/pf.ora' FROM SPFILE;");
    const cat = run(sh, 'HOST cat /tmp/pf.ora');
    expect(cat).toMatch(/db_name=/i);
    expect(cat).toMatch(/instance_name=/i);
    expect(cat).toMatch(/compatible=/i);
    sh.dispose();
  });
});

describe('CREATE SPFILE FROM PFILE imports parameters', () => {
  it('parameters defined in the source pfile become visible in v$parameter', () => {
    const sh = s('sp1');
    // Write a stub pfile via HOST echo.
    run(sh, "HOST mkdir -p /tmp/imp");
    run(sh, "HOST echo '*.cursor_sharing=FORCE' > /tmp/imp/init.ora");
    // Sanity check the file was actually written via HOST.
    const cat = run(sh, 'HOST cat /tmp/imp/init.ora');
    expect(cat, `pfile not written: ${cat}`).toContain('cursor_sharing=FORCE');
    run(sh, "CREATE SPFILE FROM PFILE='/tmp/imp/init.ora';");
    const out = run(sh, "SELECT value FROM v$parameter WHERE name='cursor_sharing';");
    expect(out).toContain('FORCE');
    sh.dispose();
  });
});

describe('V$DATAFILE.STATUS tracks tablespace state', () => {
  it('OFFLINE tablespace → datafile STATUS is OFFLINE', () => {
    const sh = s('dfst');
    run(sh, "CREATE TABLESPACE x DATAFILE '/u01/oradata/ORCL/x.dbf' SIZE 100M;");
    expect(run(sh, "SELECT name, status FROM v$datafile WHERE name LIKE '%x.dbf';")).toMatch(/ONLINE/);
    run(sh, 'ALTER TABLESPACE x OFFLINE;');
    expect(run(sh, "SELECT name, status FROM v$datafile WHERE name LIKE '%x.dbf';")).toMatch(/OFFLINE/);
    sh.dispose();
  });
});
