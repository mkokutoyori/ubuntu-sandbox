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

describe('shell lsnrctl/tnsping use the same real handler as the terminal', () => {
  it('lsnrctl status via the shell lists open PDB services (real statusBody)', () => {
    const srv = boot('shell-lsnr-1');
    const out = sh(srv, 'lsnrctl status');
    expect(out).toMatch(/Service "ORCL" has 1 instance/);
    expect(out).toMatch(/Service "ORCLPDB1" has 1 instance/);
  });

  it('lsnrctl status reflects the live listener state (stopped → TNS-12541)', () => {
    const srv = boot('shell-lsnr-2');
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.dispose();
    const out = sh(srv, 'lsnrctl status');
    expect(out).toMatch(/no listener|TNS-12541|supports no services/i);
  });

  it('tnsping resolves the local service instead of always failing TNS-03505', () => {
    const srv = boot('shell-tns-1');
    const out = sh(srv, 'tnsping ORCL');
    expect(out).toMatch(/TNS Ping Utility/);
    expect(out).not.toMatch(/TNS-03505/);
    expect(out).toMatch(/OK/);
  });
});
