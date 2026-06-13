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
  const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  sql.processLine('CREATE TABLE system.nums (n NUMBER);');
  sql.processLine('INSERT INTO system.nums VALUES (10);');
  sql.processLine('INSERT INTO system.nums VALUES (20);');
  sql.processLine('INSERT INTO system.nums VALUES (30);');
  sql.processLine('COMMIT;');
  sql.dispose();
  return srv;
}

describe('shell `sqlplus -s` runs the real query, not a hardcoded result', () => {
  it('SUM aggregate returns the real value', () => {
    const srv = boot('shell-sql-1');
    const out = sh(srv, 'sqlplus -s system/oracle@ORCL "SELECT SUM(n) FROM system.nums"');
    expect(out).toMatch(/\b60\b/);
    expect(out).not.toMatch(/^\s*1\s*$/m);
  });

  it('COUNT reflects the real row count', () => {
    const srv = boot('shell-sql-2');
    const out = sh(srv, 'sqlplus -s system/oracle@ORCL "SELECT COUNT(*) FROM system.nums"');
    expect(out).toMatch(/\b3\b/);
  });

  it('a query piped on stdin is executed', () => {
    const srv = boot('shell-sql-3');
    const out = sh(srv, 'echo "SELECT MAX(n) FROM system.nums;" | sqlplus -s system/oracle@ORCL');
    expect(out).toMatch(/\b30\b/);
  });

  it('bad credentials report the real error, not a fake row', () => {
    const srv = boot('shell-sql-4');
    const out = sh(srv, 'sqlplus -s system/wrongpw@ORCL "SELECT 1 FROM DUAL"');
    expect(out).toMatch(/ORA-01017|invalid username\/password/i);
  });

  it('piped SQL to `/ as sysdba` is executed (not dropped)', () => {
    const srv = boot('shell-sql-5');
    const out = sh(srv, 'echo "SELECT SUM(n) FROM system.nums;" | sqlplus / as sysdba');
    expect(out).toMatch(/\b60\b/);
  });

  it('bare `/ as sysdba` with no SQL still shows the banner', () => {
    const srv = boot('shell-sql-6');
    const out = sh(srv, 'sqlplus / as sysdba');
    expect(out).toMatch(/SQL\*Plus: Release/);
  });
});
