/**
 * ALTER DATABASE DATAFILE … RESIZE — must update the size advertised
 * by v$datafile / dba_data_files and refresh the file label on disk.
 *
 * AUTOEXTEND ON/OFF must also flip the catalog flag.
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

describe('ALTER DATABASE DATAFILE … RESIZE', () => {
  it('updates the file size in v$datafile and on the VFS', () => {
    const srv = new LinuxServer('linux-server', 'ora-resize', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine("CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;");

    subShell.processLine("ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' RESIZE 250M;");

    // bytes is now numeric (so SUM(bytes)/1024/1024 works) — 250M = 262144000
    const v = subShell.processLine('SELECT name, bytes FROM v$datafile;').output.join('\n');
    expect(v).toMatch(/app_data01\.dbf\s+262144000/);

    const content = subShell.processLine('HOST cat /u01/oradata/ORCL/app_data01.dbf').output.join('\n');
    expect(content).toContain('250M');
    subShell.dispose();
  });

  it('flips AUTOEXTEND in v$datafile', () => {
    const srv = new LinuxServer('linux-server', 'ora-autoext', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine("CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M AUTOEXTEND OFF;");

    const before = subShell.processLine('SELECT name, autoextensible FROM v$datafile;').output.join('\n');
    expect(before).toMatch(/app_data01\.dbf\s+NO/);

    subShell.processLine("ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' AUTOEXTEND ON;");
    const after = subShell.processLine('SELECT name, autoextensible FROM v$datafile;').output.join('\n');
    expect(after).toMatch(/app_data01\.dbf\s+YES/);
    subShell.dispose();
  });
});
