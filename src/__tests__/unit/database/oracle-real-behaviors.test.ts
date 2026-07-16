/**
 * Real-behaviour tests for features previously implemented as
 * metadata-only no-ops. After this batch:
 *
 *  - ANALYZE TABLE COMPUTE STATISTICS sets NUM_ROWS / BLOCKS /
 *    LAST_ANALYZED on DBA_TABLES.
 *  - DROP TABLE moves the table to the recyclebin (DBA_RECYCLEBIN
 *    has a row, the table can still be FLASHBACK TABLE TO BEFORE
 *    DROP'ed). DROP TABLE … PURGE skips the recyclebin.
 *  - PURGE RECYCLEBIN really empties the recyclebin.
 *  - ALTER TABLE … ADD SUPPLEMENTAL LOG GROUP populates the
 *    DBA_LOG_GROUPS / DBA_LOG_GROUP_COLUMNS dictionary.
 *  - CREATE TABLE … PARTITION BY … marks PARTITIONED=YES on
 *    DBA_TABLES and exposes one row per partition in
 *    DBA_TAB_PARTITIONS.
 *  - CREATE TABLE with a CLOB/BLOB column populates DBA_LOBS.
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

describe('ANALYZE TABLE updates DBA_TABLES statistics', () => {
  it('NUM_ROWS reflects the actual row count after COMPUTE STATISTICS', async () => {
    const sh = s('analyze');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER);'));
    (await run(sh, 'INSERT INTO hr.t SELECT level FROM dual CONNECT BY level <= 7;'));
    // Before ANALYZE, num_rows is NULL or stale.
    (await run(sh, 'ANALYZE TABLE hr.t COMPUTE STATISTICS;'));
    const out = (await run(sh, "SELECT num_rows, last_analyzed FROM dba_tables WHERE owner='HR' AND table_name='T';"));
    expect(out).toMatch(/\b7\b/);
    sh.dispose();
  });
});

describe('Recyclebin', () => {
  it('DROP TABLE moves to recyclebin; DBA_RECYCLEBIN shows the entry', async () => {
    const sh = s('rb1');
    (await run(sh, 'CREATE TABLE hr.gone (id NUMBER);'));
    (await run(sh, 'DROP TABLE hr.gone;'));
    const out = (await run(sh, "SELECT original_name, type FROM dba_recyclebin WHERE owner='HR';"));
    expect(out).toContain('GONE');
    expect(out).toMatch(/TABLE/);
    sh.dispose();
  });

  it('DROP TABLE … PURGE skips the recyclebin', async () => {
    const sh = s('rb2');
    (await run(sh, 'CREATE TABLE hr.gone (id NUMBER);'));
    (await run(sh, 'DROP TABLE hr.gone PURGE;'));
    const out = (await run(sh, "SELECT original_name FROM dba_recyclebin WHERE owner='HR';"));
    expect(out).not.toContain('GONE');
    sh.dispose();
  });

  it('FLASHBACK TABLE … TO BEFORE DROP restores the table', async () => {
    const sh = s('rb3');
    (await run(sh, 'CREATE TABLE hr.back (id NUMBER);'));
    (await run(sh, 'DROP TABLE hr.back;'));
    expect((await run(sh, "SELECT * FROM hr.back;"))).toMatch(/ORA-00942/);
    expect((await run(sh, 'FLASHBACK TABLE hr.back TO BEFORE DROP;'))).toMatch(/Flashback complete/i);
    expect((await run(sh, 'SELECT COUNT(*) FROM hr.back;'))).not.toMatch(/ORA-/);
    sh.dispose();
  });

  it('PURGE RECYCLEBIN empties it', async () => {
    const sh = s('rb4');
    (await run(sh, 'CREATE TABLE hr.a (id NUMBER);'));
    (await run(sh, 'CREATE TABLE hr.b (id NUMBER);'));
    (await run(sh, 'DROP TABLE hr.a;'));
    (await run(sh, 'DROP TABLE hr.b;'));
    // SYSDBA owns no objects here; HR does — DBA_RECYCLEBIN is the
    // correct purge target for a cross-schema clean-up.
    (await run(sh, 'PURGE DBA_RECYCLEBIN;'));
    const out = (await run(sh, 'SELECT COUNT(*) FROM dba_recyclebin;'));
    expect(out).toMatch(/\b0\b/);
    sh.dispose();
  });
});

describe('Supplemental log groups', () => {
  it('ALTER TABLE ADD SUPPLEMENTAL LOG GROUP populates DBA_LOG_GROUPS', async () => {
    const sh = s('sup');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER, name VARCHAR2(50));'));
    (await run(sh, 'ALTER TABLE hr.t ADD SUPPLEMENTAL LOG GROUP emp_sg (id, name) ALWAYS;'));
    const groups = (await run(sh, "SELECT log_group_name, table_name FROM dba_log_groups WHERE owner='HR';"));
    expect(groups).toContain('EMP_SG');
    expect(groups).toContain('T');
    const cols = (await run(sh, "SELECT column_name FROM dba_log_group_columns WHERE log_group_name='EMP_SG';"));
    expect(cols).toContain('ID');
    expect(cols).toContain('NAME');
    sh.dispose();
  });

  it('DROP SUPPLEMENTAL LOG GROUP removes the entries', async () => {
    const sh = s('sup2');
    (await run(sh, 'CREATE TABLE hr.t (id NUMBER);'));
    (await run(sh, 'ALTER TABLE hr.t ADD SUPPLEMENTAL LOG GROUP g (id);'));
    (await run(sh, 'ALTER TABLE hr.t DROP SUPPLEMENTAL LOG GROUP g;'));
    expect((await run(sh, "SELECT COUNT(*) FROM dba_log_groups WHERE owner='HR';")))
      .toMatch(/\b0\b/);
    sh.dispose();
  });
});

describe('Partitioning', () => {
  it('CREATE TABLE … PARTITION BY RANGE marks PARTITIONED=YES on DBA_TABLES', async () => {
    const sh = s('part');
    (await run(sh,
      "CREATE TABLE hr.sales (id NUMBER, d DATE) " +
      "PARTITION BY RANGE (d) " +
      "(PARTITION p2024 VALUES LESS THAN (DATE '2025-01-01'), " +
      " PARTITION p2025 VALUES LESS THAN (DATE '2026-01-01'));"
    ));
    const out = (await run(sh, "SELECT partitioned FROM dba_tables WHERE owner='HR' AND table_name='SALES';"));
    expect(out).toContain('YES');
    sh.dispose();
  });

  it('exposes one row per partition in DBA_TAB_PARTITIONS', async () => {
    const sh = s('partlist');
    (await run(sh,
      "CREATE TABLE hr.sales (id NUMBER, d DATE) " +
      "PARTITION BY RANGE (d) " +
      "(PARTITION p2024 VALUES LESS THAN (DATE '2025-01-01'), " +
      " PARTITION p2025 VALUES LESS THAN (DATE '2026-01-01'));"
    ));
    const out = (await run(sh, "SELECT partition_name FROM dba_tab_partitions WHERE table_owner='HR' AND table_name='SALES';"));
    expect(out).toContain('P2024');
    expect(out).toContain('P2025');
    sh.dispose();
  });
});

describe('LOB columns', () => {
  it('CREATE TABLE with CLOB/BLOB columns populates DBA_LOBS', async () => {
    const sh = s('lob');
    (await run(sh, 'CREATE TABLE hr.docs (id NUMBER PRIMARY KEY, body CLOB, photo BLOB);'));
    const out = (await run(sh, "SELECT column_name FROM dba_lobs WHERE owner='HR' AND table_name='DOCS';"));
    expect(out).toContain('BODY');
    expect(out).toContain('PHOTO');
    sh.dispose();
  });
});
