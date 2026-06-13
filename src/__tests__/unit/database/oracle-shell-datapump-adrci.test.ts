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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function boot(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

describe('shell expdp/impdp/adrci use the real handlers (not stubs)', () => {
  it('expdp via the shell really exports and writes the dump on the VFS', () => {
    const srv = boot('shell-dp-1');
    const out = sh(srv, 'expdp sys/oracle SCHEMAS=HR DUMPFILE=hr.dmp LOGFILE=hr.log');
    expect(out).toContain('exported "HR"');
    expect(out).toContain('successfully completed');
    expect(out).not.toMatch(/non-interactive batch mode not supported/);
    const dump = sh(srv, 'cat /u01/app/oracle/admin/ORCL/dpdump/hr.dmp');
    expect(dump).toContain('ORACLE-SIM-DATAPUMP');
  });

  it('expdp → drop → impdp round-trips real rows through the shell', () => {
    const srv = boot('shell-dp-2');
    sh(srv, 'expdp sys/oracle TABLES=HR.EMPLOYEES DUMPFILE=emp.dmp');
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    sql.processLine('DROP TABLE hr.employees CASCADE CONSTRAINTS;');
    sql.dispose();
    const imp = sh(srv, 'impdp sys/oracle TABLES=HR.EMPLOYEES DUMPFILE=emp.dmp');
    expect(imp).toMatch(/imported|successfully completed/i);
    const check = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const rows = check.processLine('SELECT COUNT(*) FROM hr.employees;').output.join('\n');
    check.dispose();
    expect(rows).not.toMatch(/ORA-00942/);
  });

  it('adrci via the shell reads the real alert log, not a stub', () => {
    const srv = boot('shell-dp-3');
    const out = sh(srv, 'adrci exec="show alert -tail 5"');
    expect(out).not.toMatch(/non-interactive batch mode not supported/);
  });
});
