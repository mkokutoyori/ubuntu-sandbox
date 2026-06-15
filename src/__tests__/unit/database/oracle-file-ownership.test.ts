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

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const ls = (srv: LinuxServer, path: string) =>
  srv.executeShellCommandSync(`ls -l ${path}`);

describe('Oracle tree ownership on the host filesystem', () => {
  it('ORACLE_HOME binaries belong to oracle:oinstall', () => {
    const srv = bootOracleServer('own1');
    expect(ls(srv, '/u01/app/oracle/product/19c/dbhome_1/bin/sqlplus'))
      .toMatch(/oracle\s+oinstall/);
  });

  it('datafiles and control files belong to oracle:oinstall', () => {
    const srv = bootOracleServer('own2');
    const out = srv.executeShellCommandSync('ls -l /u01/app/oracle/oradata/ORCL/');
    expect(out).toMatch(/oracle\s+oinstall.*system01\.dbf/);
    expect(out).toMatch(/oracle\s+oinstall.*control01\.ctl/);
  });

  it('the alert log written by the engine belongs to oracle:oinstall', () => {
    const srv = bootOracleServer('own3');
    expect(ls(srv, '/u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log'))
      .toMatch(/oracle\s+oinstall/);
  });

  it('files generated after boot keep the oracle identity', () => {
    const srv = bootOracleServer('own4');
    const sh = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    sh.processLine("ALTER SYSTEM SET open_cursors = 500 SCOPE=SPFILE;");
    sh.dispose();
    expect(ls(srv, '/u01/app/oracle/product/19c/dbhome_1/dbs/spfileORCL.ora'))
      .toMatch(/oracle\s+oinstall/);
  });

  it('/etc/oratab stays root-owned, like a real install', () => {
    const srv = bootOracleServer('own5');
    expect(ls(srv, '/etc/oratab')).toMatch(/root\s+root/);
  });
});
