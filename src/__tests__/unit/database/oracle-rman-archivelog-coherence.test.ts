import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { LinuxRmanContext } from '@/terminal/subshells/rman/integration/LinuxRmanContext';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const ARC_DIR = '/u01/app/oracle/archivelog';

function bootArchivelog(name: string): { srv: LinuxServer; sql: SqlPlusSubShell } {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  return { srv, sql: subShell };
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

describe('RMAN sees the same archived logs the instance created', () => {
  it('getArchivelogPaths matches V$ARCHIVED_LOG and the VFS files', () => {
    const { srv, sql } = bootArchivelog('arc-rman-1');
    sql.processLine('ALTER SYSTEM SWITCH LOGFILE;');
    sql.processLine('ALTER SYSTEM SWITCH LOGFILE;');

    const ctx = LinuxRmanContext.forDevice(srv);
    const rmanPaths = ctx.getArchivelogPaths();
    expect(rmanPaths.length).toBeGreaterThan(0);

    const viewNames = sql.processLine('SELECT name FROM v$archived_log;').output.join('\n');
    for (const p of rmanPaths) {
      expect(viewNames).toContain(p);
      expect(sh(srv, `ls ${p}`)).not.toMatch(/No such file/);
    }
    sql.dispose();
  });

  it('returns no archived logs before any log switch', () => {
    const { srv, sql } = bootArchivelog('arc-rman-2');
    const ctx = LinuxRmanContext.forDevice(srv);
    expect(ctx.getArchivelogPaths().length).toBe(0);
    sql.dispose();
  });

  it('no phantom /u01/backup archivelog paths are reported', () => {
    const { srv, sql } = bootArchivelog('arc-rman-3');
    sql.processLine('ALTER SYSTEM SWITCH LOGFILE;');
    const ctx = LinuxRmanContext.forDevice(srv);
    for (const p of ctx.getArchivelogPaths()) {
      expect(p.startsWith(ARC_DIR)).toBe(true);
    }
    sql.dispose();
  });
});
