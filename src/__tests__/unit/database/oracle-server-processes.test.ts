/**
 * Dedicated server processes — sessions exist in the OS process table.
 *
 * Before: V$PROCESS showed only the background processes and `ps` knew
 * nothing about connections — a connected session had no OS footprint,
 * V$SESSION.PADDR pointed nowhere (each view invented its own address
 * scheme, so the canonical s.paddr = p.addr join returned nothing), and
 * OracleDatabase.closeSession had NO caller: every disconnect leaked the
 * live session object forever.
 *
 * Now: openSession forks a dedicated server process — bequeath
 * (LOCAL=YES) or Oracle Net (LOCAL=NO) — that appears in V$PROCESS, in
 * the host `ps` (via the server-process events), and dies on
 * disconnect/shutdown, exactly like the real fork-per-connection model.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { DEFAULT_OS_CONTEXT } from '@/database/oracle/security/types';

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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

describe('bequeath connections appear in ps as oracleSID (LOCAL=YES)', () => {
  it('a live sqlplus / as sysdba session has its dedicated server in ps', () => {
    const srv = bootOracleServer('sp1');
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const ps = sh(srv, 'ps aux');
    expect(ps).toMatch(/oracleORCL \(DESCRIPTION=\(LOCAL=YES\)\(ADDRESS=\(PROTOCOL=beq\)\)\)/);
    subShell.dispose();
  });

  it('the process disappears when the session disconnects', () => {
    const srv = bootOracleServer('sp2');
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.dispose();
    expect(sh(srv, 'ps aux')).not.toMatch(/LOCAL=YES/);
  });

  it('SHUTDOWN kills every dedicated server (PMON cleanup)', () => {
    const srv = bootOracleServer('sp3');
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    subShell.processLine('SHUTDOWN IMMEDIATE');
    expect(sh(srv, 'ps aux')).not.toMatch(/oracleORCL \(/);
    subShell.dispose();
  });
});

describe('V$PROCESS and V$SESSION tell the same story as ps', () => {
  it('V$PROCESS has a dedicated server row (PNAME null, oracle@SID)', () => {
    const srv = bootOracleServer('sp4');
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const out = subShell.processLine(
      "SELECT COUNT(*) FROM v$process WHERE pname IS NULL AND program = 'oracle@ORCL';"
    ).output.join('\n');
    expect(out).toMatch(/\b1\b/);
    subShell.dispose();
  });

  it('the canonical s.paddr = p.addr join resolves the SPID seen in ps', () => {
    const srv = bootOracleServer('sp5');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const procs = db.instance.getServerProcesses();
    expect(procs.length).toBeGreaterThan(0);
    const spid = procs[procs.length - 1].pid;
    const out = subShell.processLine(
      'SELECT p.spid FROM v$session s, v$process p '
      + "WHERE s.paddr = p.addr AND s.username = 'SYS';"
    ).output.join('\n');
    expect(out).toContain(String(spid));
    // …and ps shows the dedicated server owned by the oracle software
    // account. (The host process table allocates its own pid namespace,
    // so the ps pid differs from SPID — same pre-existing approximation
    // as the ora_pmon/ora_smon background processes.)
    expect(sh(srv, 'ps aux')).toMatch(/oracle\s+\d+.*oracleORCL \(/);
    subShell.dispose();
  });
});

describe('Oracle Net connections fork LOCAL=NO servers', () => {
  it('engine: a tcp-transport connect is tracked as non-local', () => {
    const db = new OracleDatabase();
    db.instance.startup('OPEN');
    const sys = db.connectAsSysdba();
    db.executeSql(sys.executor, "CREATE USER netuser IDENTIFIED BY pw");
    db.executeSql(sys.executor, 'GRANT CREATE SESSION TO netuser');
    const { sid } = db.connect('NETUSER', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const proc = db.instance.getServerProcess(sid);
    expect(proc).toBeDefined();
    expect(proc!.local).toBe(false);
    expect(db.instance.serverProcessCommand(proc!.local)).toBe('oracleORCL (LOCAL=NO)');
    db.disconnect(sid);
    expect(db.instance.getServerProcess(sid)).toBeUndefined();
  });

  it('sqlplus user/pass@alias lands as LOCAL=NO in ps (loopback through the listener)', () => {
    const srv = bootOracleServer('sp6');
    const { subShell } = SqlPlusSubShell.create(srv, ['system/oracle@ORCL']);
    const ps = sh(srv, 'ps aux');
    expect(ps).toMatch(/oracleORCL \(LOCAL=NO\)/);
    subShell.dispose();
  });
});

describe('disconnect no longer leaks the live session', () => {
  it('getOpenSessions shrinks back after disconnect', () => {
    const db = new OracleDatabase();
    db.instance.startup('OPEN');
    const before = db.getOpenSessions().length;
    const sys = db.connectAsSysdba();
    expect(db.getOpenSessions().length).toBe(before + 1);
    db.disconnect(sys.sid);
    expect(db.getOpenSessions().length).toBe(before);
  });
});
