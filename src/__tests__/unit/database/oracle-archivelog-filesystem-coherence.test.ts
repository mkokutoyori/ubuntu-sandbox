/**
 * Archive-log ↔ VFS coherence. When the instance is in ARCHIVELOG mode
 * and a redo group fills up (or `ALTER SYSTEM SWITCH LOGFILE` is
 * issued), the archived file should appear under the archivelog dir.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

describe('archive log → VFS', () => {
  it('writes an .arc file under archivelog/ on each log switch in ARCHIVELOG mode', () => {
    const srv = new LinuxServer('linux-server', 'ora-arc', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);

    // Force ARCHIVELOG via the instance API (the MOUNT/OPEN cycle from
    // SQL*Plus isn't the focus of this test).
    const db = getOracleDatabase(srv.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;

    subShell.processLine('ALTER SYSTEM SWITCH LOGFILE;');
    subShell.processLine('ALTER SYSTEM SWITCH LOGFILE;');

    const out = subShell.processLine(
      'HOST ls /u01/app/oracle/archivelog'
    ).output.join('\n');
    expect(out).toMatch(/\.arc/);
    subShell.dispose();
  });

  it('does not write archive files in NOARCHIVELOG mode (default)', () => {
    const srv = new LinuxServer('linux-server', 'ora-noarc', 100, 100);
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine('ALTER SYSTEM SWITCH LOGFILE;');
    const out = subShell.processLine(
      "HOST find /u01/app/oracle/archivelog -name '*.arc' -type f"
    ).output.join('\n');
    expect(out).not.toMatch(/\.arc/);
    subShell.dispose();
  });
});
