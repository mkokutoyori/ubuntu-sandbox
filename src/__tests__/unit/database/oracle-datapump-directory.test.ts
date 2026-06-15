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

function runSql(srv: LinuxServer, line: string): string {
  const s = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  const out = s.processLine(line).output.join('\n');
  s.dispose();
  return out;
}

describe('Data Pump resolves DIRECTORY= against the real directory object', () => {
  it('expdp writes the dump at the custom directory object path', () => {
    const srv = boot('dp-dir-1');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    const out = sh(srv, 'expdp sys/oracle SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp');
    expect(out).toContain('/home/oracle/dp/hr.dmp');
    expect(out).toContain('successfully completed');
    expect(sh(srv, 'cat /home/oracle/dp/hr.dmp')).toContain('ORACLE-SIM-DATAPUMP');
  });

  it('expdp → drop → impdp round-trips through a custom DIRECTORY', () => {
    const srv = boot('dp-dir-2');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    sh(srv, 'expdp sys/oracle TABLES=HR.EMPLOYEES DIRECTORY=MY_DP DUMPFILE=emp.dmp');
    runSql(srv, 'DROP TABLE hr.employees CASCADE CONSTRAINTS;');
    const imp = sh(srv, 'impdp sys/oracle TABLES=HR.EMPLOYEES DIRECTORY=MY_DP DUMPFILE=emp.dmp');
    expect(imp).toMatch(/imported|successfully completed/i);
    const rows = runSql(srv, 'SELECT COUNT(*) FROM hr.employees;');
    expect(rows).not.toMatch(/ORA-00942/);
  });

  it('expdp with an unknown DIRECTORY fails with ORA-39087', () => {
    const srv = boot('dp-dir-3');
    const out = sh(srv, 'expdp sys/oracle SCHEMAS=HR DIRECTORY=NO_SUCH_DIR DUMPFILE=x.dmp');
    expect(out).toMatch(/ORA-39087/);
    expect(out).not.toContain('successfully completed');
  });

  it('impdp with an unknown DIRECTORY fails with ORA-39087', () => {
    const srv = boot('dp-dir-4');
    const out = sh(srv, 'impdp sys/oracle SCHEMAS=HR DIRECTORY=NO_SUCH_DIR DUMPFILE=x.dmp');
    expect(out).toMatch(/ORA-39087/);
  });

  it('expdp without DIRECTORY still uses the seeded DATA_PUMP_DIR', () => {
    const srv = boot('dp-dir-5');
    const out = sh(srv, 'expdp sys/oracle SCHEMAS=HR DUMPFILE=hr.dmp');
    expect(out).toContain('/u01/app/oracle/admin/ORCL/dpdump/hr.dmp');
    expect(sh(srv, 'cat /u01/app/oracle/admin/ORCL/dpdump/hr.dmp')).toContain('ORACLE-SIM-DATAPUMP');
  });
});

describe('Data Pump enforces directory privileges', () => {
  it('expdp as a user without WRITE on the directory is denied', () => {
    const srv = boot('dp-priv-1');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    runSql(srv, 'CREATE USER dpu IDENTIFIED BY pw;');
    runSql(srv, 'GRANT CREATE SESSION TO dpu;');
    const out = sh(srv, 'expdp dpu/pw SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp');
    expect(out).toMatch(/29289|access denied/i);
    expect(out).not.toContain('successfully completed');
  });

  it('granting WRITE lets the user run expdp', () => {
    const srv = boot('dp-priv-2');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    runSql(srv, 'CREATE USER dpu IDENTIFIED BY pw;');
    runSql(srv, 'GRANT CREATE SESSION TO dpu;');
    runSql(srv, 'GRANT WRITE ON DIRECTORY my_dp TO dpu;');
    const out = sh(srv, 'expdp dpu/pw SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp');
    expect(out).toContain('successfully completed');
  });

  it('impdp requires READ on the directory', () => {
    const srv = boot('dp-priv-3');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    runSql(srv, 'CREATE USER dpu IDENTIFIED BY pw;');
    runSql(srv, 'GRANT CREATE SESSION TO dpu;');
    sh(srv, 'expdp sys/oracle SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp');
    const denied = sh(srv, 'impdp dpu/pw SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp TABLE_EXISTS_ACTION=SKIP');
    expect(denied).toMatch(/29289|access denied/i);
    runSql(srv, 'GRANT READ ON DIRECTORY my_dp TO dpu;');
    const ok = sh(srv, 'impdp dpu/pw SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp TABLE_EXISTS_ACTION=SKIP');
    expect(ok).not.toMatch(/29289/);
  });

  it('SYS runs Data Pump without an explicit directory grant', () => {
    const srv = boot('dp-priv-4');
    sh(srv, 'mkdir -p /home/oracle/dp');
    runSql(srv, "CREATE DIRECTORY my_dp AS '/home/oracle/dp';");
    const out = sh(srv, 'expdp sys/oracle SCHEMAS=HR DIRECTORY=MY_DP DUMPFILE=hr.dmp');
    expect(out).toContain('successfully completed');
  });
});
