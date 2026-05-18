/**
 * Column-set fidelity for v$datafile / dba_data_files / v$tempfile /
 * dba_temp_files. Real-world DBA queries pull STATUS, MAXBYTES,
 * BLOCKS, USER_BYTES, CREATION_TIME etc. — those used to throw
 * ORA-00904.
 *
 * Also pins down:
 *   - BYTES must be a Number (so SUM(bytes)/1024/1024 returns a number,
 *     not NaN as it did when bytes was stored as "100M");
 *   - v$datafile must exclude TEMP datafiles (they belong to v$tempfile);
 *   - dba_data_files count and v$datafile count must agree.
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

function sql(s: { processLine: (l: string) => { output: string[] } }, q: string): string {
  return s.processLine(q).output.join('\n');
}

describe('dba_data_files / v$datafile column set', () => {
  it('dba_data_files exposes STATUS / MAXBYTES / BLOCKS / USER_BYTES', () => {
    const srv = new LinuxServer('linux-server', 'ora-df-cols', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = sql(subShell,
      'SELECT file_id, file_name, tablespace_name, bytes, status, autoextensible, maxbytes, blocks, user_bytes FROM dba_data_files;'
    );
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/AVAILABLE/);
    subShell.dispose();
  });

  it('v$datafile exposes STATUS / CHECKPOINT_CHANGE# / CREATION_TIME', () => {
    const srv = new LinuxServer('linux-server', 'ora-vdf-cols', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = sql(subShell,
      'SELECT file#, name, status, checkpoint_change#, creation_time FROM v$datafile;'
    );
    expect(out).not.toMatch(/ORA-/);
    expect(out).toMatch(/ONLINE/);
    subShell.dispose();
  });

  it('v$datafile excludes TEMP files (they belong to v$tempfile)', () => {
    const srv = new LinuxServer('linux-server', 'ora-vdf-temp', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = sql(subShell, 'SELECT name FROM v$datafile;');
    expect(out).not.toMatch(/temp01\.dbf/);
    const t = sql(subShell, 'SELECT name FROM v$tempfile;');
    expect(t).toMatch(/temp01\.dbf/);
    subShell.dispose();
  });

  it('dba_data_files COUNT matches v$datafile COUNT (cross-validation)', () => {
    const srv = new LinuxServer('linux-server', 'ora-cross', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const a = sql(subShell, 'SELECT COUNT(*) FROM dba_data_files;');
    const b = sql(subShell, 'SELECT COUNT(*) FROM v$datafile;');
    const numA = Number(a.match(/\d+/g)?.pop());
    const numB = Number(b.match(/\d+/g)?.pop());
    expect(numA).toBe(numB);
    expect(numA).toBeGreaterThan(0);
    subShell.dispose();
  });

  it('SUM(bytes)/1024/1024 returns a number, not NaN', () => {
    const srv = new LinuxServer('linux-server', 'ora-bytes', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = sql(subShell,
      'SELECT tablespace_name, SUM(bytes)/1024/1024 AS total_mb FROM dba_data_files GROUP BY tablespace_name;'
    );
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/SYSTEM\s+\d/);
    subShell.dispose();
  });
});
