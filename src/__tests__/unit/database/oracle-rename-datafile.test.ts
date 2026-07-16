/**
 * ALTER DATABASE RENAME FILE — must rename the datafile in both the
 * Oracle catalog (v$datafile / dba_data_files) and on the device VFS,
 * otherwise the path advertised by the views is broken.
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

async function ls(s: { processLine: (l: string) => { output: string[] } | Promise<{ output: string[] }> }, p: string): Promise<string> {
  return (await s.processLine(`HOST ls ${p}`)).output.join('\n');
}

describe('ALTER DATABASE RENAME FILE', () => {
  it('moves the datafile to the new path on the VFS', async () => {
    const srv = new LinuxServer('linux-server', 'ora-rename', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    (await subShell.processLine("CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;"));
    expect((await ls(subShell, '/u01/oradata/ORCL/'))).toContain('app_data01.dbf');

    (await subShell.processLine(
      "ALTER DATABASE RENAME FILE '/u01/oradata/ORCL/app_data01.dbf' TO '/u02/oradata/ORCL/app_data01.dbf';"
    ));

    // Old path is gone, new path exists.
    expect((await ls(subShell, '/u01/oradata/ORCL/'))).not.toContain('app_data01.dbf');
    expect((await ls(subShell, '/u02/oradata/ORCL/'))).toContain('app_data01.dbf');
    subShell.dispose();
  });

  it('reflects the new path in v$datafile / dba_data_files', async () => {
    const srv = new LinuxServer('linux-server', 'ora-rename-cat', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    (await subShell.processLine("CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;"));
    (await subShell.processLine(
      "ALTER DATABASE RENAME FILE '/u01/oradata/ORCL/app_data01.dbf' TO '/u02/oradata/ORCL/app_data01.dbf';"
    ));
    const v = (await subShell.processLine('SELECT name FROM v$datafile;')).output.join('\n');
    expect(v).toContain('/u02/oradata/ORCL/app_data01.dbf');
    expect(v).not.toContain('/u01/oradata/ORCL/app_data01.dbf');

    const dba = (await subShell.processLine('SELECT file_name FROM dba_data_files;')).output.join('\n');
    expect(dba).toContain('/u02/oradata/ORCL/app_data01.dbf');
    subShell.dispose();
  });
});
