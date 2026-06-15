import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
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

function openUserSession(srv: LinuxServer) {
  const db = getOracleDatabase(srv.getId());
  const s = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  s.processLine('CREATE USER psu IDENTIFIED BY pw;');
  s.processLine('GRANT CREATE SESSION TO psu;');
  s.dispose();
  const conn = db.connect('psu', 'pw');
  return { db, sid: conn.sid };
}

describe('Killing an Oracle server process from the OS terminates the session', () => {
  it('pkill of the server process ends the Oracle session and clears ps', () => {
    const srv = boot('proc-2');
    const { db, sid } = openUserSession(srv);
    expect(db.getSession(sid)).toBeDefined();
    expect(sh(srv, 'ps -ef')).toMatch(/oraclePROC|oracleORCL/i);

    sh(srv, 'pkill -9 oracleORCL');

    expect(db.getSession(sid)).toBeUndefined();
    expect(sh(srv, 'ps -ef')).not.toMatch(/oracleORCL/);
  });

  it('a non-terminating signal (SIGCONT) leaves the session alive', () => {
    const srv = boot('proc-3');
    const { db, sid } = openUserSession(srv);
    expect(db.getSession(sid)).toBeDefined();
    sh(srv, 'pkill -CONT oracleORCL');
    expect(db.getSession(sid)).toBeDefined();
  });
});
