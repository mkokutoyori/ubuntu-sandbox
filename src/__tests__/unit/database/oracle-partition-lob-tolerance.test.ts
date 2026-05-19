/**
 * Partitioning + LOB storage parser tolerance.
 *
 * The simulator does not implement partitioning or LOB segments, but
 * the parser shouldn't reject the DDL — DBA scripts that touch
 * partitioned tables (or LOB columns) need to make progress with the
 * partition / LOB clauses ignored.
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

describe('CREATE TABLE … PARTITION BY …', () => {
  it('accepts PARTITION BY RANGE with INTERVAL', () => {
    const sh = s('p1');
    const out = run(sh,
      "CREATE TABLE hr.sales_part (id NUMBER, sale_date DATE, region VARCHAR2(50), amount NUMBER) " +
      "PARTITION BY RANGE (sale_date) INTERVAL (NUMTOYMINTERVAL(1,'MONTH')) " +
      "(PARTITION p0 VALUES LESS THAN (DATE '2023-01-01'));"
    );
    expect(out).toMatch(/Table created/i);
    expect(run(sh, "SELECT table_name FROM dba_tables WHERE table_name='SALES_PART';"))
      .toContain('SALES_PART');
    sh.dispose();
  });

  it('accepts PARTITION BY LIST', () => {
    const sh = s('p2');
    const out = run(sh,
      "CREATE TABLE hr.r (id NUMBER, region VARCHAR2(10)) " +
      "PARTITION BY LIST (region) (PARTITION p_eu VALUES ('EU'), PARTITION p_us VALUES ('US'));"
    );
    expect(out).toMatch(/Table created/i);
    sh.dispose();
  });

  it('accepts PARTITION BY HASH (col) PARTITIONS n', () => {
    const sh = s('p3');
    const out = run(sh,
      "CREATE TABLE hr.h (id NUMBER) PARTITION BY HASH (id) PARTITIONS 4;"
    );
    expect(out).toMatch(/Table created/i);
    sh.dispose();
  });
});

describe('ALTER TABLE … (partition operations)', () => {
  beforeEach(() => undefined);

  it('partition operations don\'t throw', () => {
    const sh = s('part-ops');
    run(sh,
      "CREATE TABLE hr.sp (id NUMBER, d DATE) " +
      "PARTITION BY RANGE (d) (PARTITION p0 VALUES LESS THAN (DATE '2023-01-01'));"
    );
    for (const stmt of [
      'ALTER TABLE hr.sp MODIFY PARTITION p0 SHRINK SPACE;',
      "ALTER TABLE hr.sp MOVE PARTITION FOR (DATE '2024-05-15') TABLESPACE users;",
      "ALTER TABLE hr.sp TRUNCATE PARTITION FOR (DATE '2024-05-15');",
      "ALTER TABLE hr.sp SPLIT PARTITION p0 AT (DATE '2022-01-01') INTO (PARTITION p_old, PARTITION p_new);",
      'ALTER TABLE hr.sp MERGE PARTITIONS p_old, p_new INTO PARTITION p0;',
      'ALTER TABLE hr.sp DROP PARTITION p0;',
    ]) {
      const out = run(sh, stmt);
      expect(out, `failed: ${stmt}`).toMatch(/Table altered/i);
    }
    sh.dispose();
  });
});

describe('CREATE TABLE … LOB (col) STORE AS …', () => {
  it('accepts LOB storage clauses', () => {
    const sh = s('lob1');
    const out = run(sh,
      "CREATE TABLE hr.with_lob (id NUMBER PRIMARY KEY, payload CLOB, photo BLOB) " +
      "LOB(payload) STORE AS SECUREFILE (TABLESPACE users COMPRESS HIGH DEDUPLICATE CACHE) " +
      "LOB(photo) STORE AS BASICFILE (TABLESPACE users);"
    );
    expect(out).toMatch(/Table created/i);
    sh.dispose();
  });

  it('ALTER TABLE … MODIFY LOB / MOVE LOB are accepted', () => {
    const sh = s('lob2');
    run(sh,
      "CREATE TABLE hr.with_lob (id NUMBER, payload CLOB);"
    );
    expect(run(sh, 'ALTER TABLE hr.with_lob MODIFY LOB (payload) (RETENTION);')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.with_lob MOVE LOB (payload) STORE AS SECUREFILE (TABLESPACE users);')).toMatch(/Table altered/i);
    sh.dispose();
  });
});
