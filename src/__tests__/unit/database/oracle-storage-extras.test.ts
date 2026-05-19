/**
 * Storage / DDL gaps surfaced by the oracle-storage-spaces transcript:
 *   - DBA_TABLESPACES exposes DEF_TAB_COMPRESSION and RETENTION
 *   - DBA_TABLES exposes CHAIN_CNT
 *   - DBA_FREE_SPACE_COALESCED, V\$ASM_DISK_IOSTAT, V\$ASM_ATTRIBUTE,
 *     DBA_LOBS / DBA_LOB_PARTITIONS / DBA_LOB_SUBPARTITIONS — empty
 *     views (truth) instead of ORA-00942.
 *   - CREATE BIGFILE TEMPORARY TABLESPACE …
 *   - ALTER TABLE … ROW STORE COMPRESS / NOCOMPRESS
 *   - ALTER INDEX … REBUILD ONLINE
 *   - DROP TABLE … PURGE
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

describe('column additions', () => {
  it('DBA_TABLESPACES exposes DEF_TAB_COMPRESSION and RETENTION', () => {
    const sh = s('dts');
    const out = run(sh, 'SELECT tablespace_name, def_tab_compression, retention FROM dba_tablespaces;');
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/DISABLED/);
    sh.dispose();
  });

  it('DBA_TABLES exposes CHAIN_CNT', () => {
    const sh = s('chaincnt');
    const out = run(sh, "SELECT table_name, chain_cnt FROM dba_tables WHERE owner = 'HR';");
    expect(out).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('empty-by-default views', () => {
  it.each([
    'DBA_FREE_SPACE_COALESCED',
    'V$ASM_DISK_IOSTAT',
    'V$ASM_ATTRIBUTE',
    'DBA_LOBS',
    'DBA_LOB_PARTITIONS',
    'DBA_LOB_SUBPARTITIONS',
  ])('SELECT * FROM %s does not throw ORA-00942', (view) => {
    const sh = s(`view-${view}`);
    const out = run(sh, `SELECT * FROM ${view};`);
    expect(out).not.toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('DDL parser tolerance', () => {
  it('CREATE BIGFILE TEMPORARY TABLESPACE …', () => {
    const sh = s('bigtemp');
    const out = run(sh,
      "CREATE BIGFILE TEMPORARY TABLESPACE temp_big TEMPFILE '/u01/oradata/ORCL/temp_big.dbf' SIZE 500M;"
    );
    expect(out).toMatch(/Tablespace created/i);
    sh.dispose();
  });

  it('ALTER TABLE … ROW STORE COMPRESS / NOCOMPRESS', () => {
    const sh = s('compress');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'ALTER TABLE hr.t ROW STORE COMPRESS ADVANCED;')).toMatch(/Table altered/i);
    expect(run(sh, 'ALTER TABLE hr.t NOCOMPRESS;')).toMatch(/Table altered/i);
    sh.dispose();
  });

  it('ALTER INDEX … REBUILD ONLINE', () => {
    const sh = s('reb');
    run(sh, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY);');
    run(sh, 'CREATE INDEX hr.i ON hr.t (id);');
    expect(run(sh, 'ALTER INDEX hr.i REBUILD ONLINE;')).toMatch(/Index altered/i);
    sh.dispose();
  });

  it('DROP TABLE … PURGE removes the table without recyclebin', () => {
    const sh = s('purge');
    run(sh, 'CREATE TABLE hr.t (id NUMBER);');
    expect(run(sh, 'DROP TABLE hr.t PURGE;')).toMatch(/Table dropped/i);
    sh.dispose();
  });
});
