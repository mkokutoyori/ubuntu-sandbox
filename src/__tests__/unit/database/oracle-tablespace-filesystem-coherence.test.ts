/**
 * Tablespace ↔ filesystem coherence.
 *
 * When the DBA issues `CREATE TABLESPACE … DATAFILE 'path' SIZE …`,
 * the datafile must appear on the underlying Linux VFS — otherwise
 * v$datafile / dba_data_files would advertise paths that do not
 * exist on the host. Likewise, `DROP TABLESPACE … INCLUDING DATAFILES`
 * must physically delete those files.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

function ls(subShell: { processLine: (l: string) => { output: string[] } }, path: string): string {
  return subShell.processLine(`HOST ls ${path}`).output.join('\n');
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

describe('CREATE TABLESPACE → datafile materialised on the VFS', () => {
  it('writes a fresh datafile when a permanent tablespace is created', () => {
    const srv = new LinuxServer('linux-server', 'ora-ts-create', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine(
      "CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;"
    );
    const out = ls(subShell, '/u01/oradata/ORCL/');
    expect(out).toContain('app_data01.dbf');
    const content = subShell.processLine(
      'HOST cat /u01/oradata/ORCL/app_data01.dbf'
    ).output.join('\n');
    expect(content).toContain('ORACLE DATAFILE');
    expect(content).toContain('APP_DATA');
    subShell.dispose();
  });

  it('writes a TEMPFILE label for a temporary tablespace', () => {
    const srv = new LinuxServer('linux-server', 'ora-ts-temp', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine(
      "CREATE TEMPORARY TABLESPACE temp_data TEMPFILE '/u01/oradata/ORCL/temp_data01.dbf' SIZE 100M;"
    );
    const content = subShell.processLine(
      'HOST cat /u01/oradata/ORCL/temp_data01.dbf'
    ).output.join('\n');
    expect(content).toContain('TEMPFILE');
    expect(content).toContain('TEMP_DATA');
    subShell.dispose();
  });

  it('removes the datafile when DROP TABLESPACE … INCLUDING DATAFILES is issued', () => {
    const srv = new LinuxServer('linux-server', 'ora-ts-drop', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine(
      "CREATE TABLESPACE archive_data DATAFILE '/u01/oradata/ORCL/archive01.dbf' SIZE 100M;"
    );
    expect(ls(subShell, '/u01/oradata/ORCL/')).toContain('archive01.dbf');

    subShell.processLine('DROP TABLESPACE archive_data INCLUDING CONTENTS AND DATAFILES;');
    expect(ls(subShell, '/u01/oradata/ORCL/')).not.toContain('archive01.dbf');
    subShell.dispose();
  });

  it('keeps the datafile on disk for a plain DROP TABLESPACE (no INCLUDING DATAFILES)', () => {
    const srv = new LinuxServer('linux-server', 'ora-ts-keep', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine(
      "CREATE TABLESPACE keep_ts DATAFILE '/u01/oradata/ORCL/keep01.dbf' SIZE 50M;"
    );
    subShell.processLine('DROP TABLESPACE keep_ts;');
    // Real Oracle leaves the OS file behind in this case.
    expect(ls(subShell, '/u01/oradata/ORCL/')).toContain('keep01.dbf');
    subShell.dispose();
  });
});
