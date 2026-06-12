/**
 * Datafile ⇄ host-filesystem coherence.
 *
 * Before: the VFS copies of the datafiles were write-only props — an
 * `rm` from bash changed nothing (the next state-change sync even
 * recreated the file), STARTUP always opened, and RMAN RESTORE only
 * printed messages without putting any file back on disk.
 *
 * Now the OS view is authoritative, with the real Oracle semantics:
 *  - deleting a datafile does NOT hurt the running instance (the OS
 *    keeps the open inode on a real host too);
 *  - the next OPEN fails with ORA-01157/ORA-01110 and the instance
 *    stays MOUNTed;
 *  - RMAN RESTORE genuinely rewrites the file, after which
 *    ALTER DATABASE OPEN succeeds — the standard DBA recovery loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const USERS_DBF = '/u01/app/oracle/oradata/ORCL/users01.dbf';

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function sqlplus(srv: LinuxServer) {
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  return subShell;
}

describe('rm of a datafile follows the real Oracle failure ladder', () => {
  it('a running instance is not affected (open inode semantics)', () => {
    const srv = bootOracleServer('df1');
    sh(srv, `rm ${USERS_DBF}`);
    const sql = sqlplus(srv);
    const out = sql.processLine('SELECT COUNT(*) FROM hr.employees;').output.join('\n');
    expect(out).not.toMatch(/ORA-/);
    sql.dispose();
  });

  it('the deleted file is NOT resurrected by later instance activity', () => {
    const srv = bootOracleServer('df2');
    expect(sh(srv, `ls ${USERS_DBF}`)).toContain('users01.dbf');
    sh(srv, `rm ${USERS_DBF}`);

    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP'); // re-mounts → datafile sync runs again
    sql.dispose();
    expect(sh(srv, `ls ${USERS_DBF}`)).toMatch(/No such file/);
  });

  it('STARTUP stops at MOUNT with ORA-01157/ORA-01110', () => {
    const srv = bootOracleServer('df3');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    sh(srv, `rm ${USERS_DBF}`);

    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    const out = sql.processLine('STARTUP').output.join('\n');
    expect(out).toMatch(/ORA-01157: cannot identify\/lock data file 4/);
    expect(out).toMatch(/ORA-01110: data file 4: '\/u01\/app\/oracle\/oradata\/ORCL\/users01\.dbf'/);
    expect(out).toMatch(/Database mounted/);
    expect(out).not.toMatch(/Database opened/);
    expect(db.instance.state).toBe('MOUNT');
    sql.dispose();
  });

  it('RMAN RESTORE rewrites the file; ALTER DATABASE OPEN then succeeds', () => {
    const srv = bootOracleServer('df4');
    const db = getRegisteredOracleDatabase(srv.getId())!;

    // Take a backup while everything is healthy.
    const rman1 = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman1.subShell.processLine('backup database;');
    rman1.subShell.dispose();

    // Lose the datafile, restart: stuck at MOUNT.
    sh(srv, `rm ${USERS_DBF}`);
    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP');
    expect(db.instance.state).toBe('MOUNT');

    // Standard recovery: restore the lost file from the backup.
    const rman2 = ReactiveRmanSubShell.create(srv, ['target', '/']);
    const restoreOut = rman2.subShell.processLine('restore datafile 4;').output.join('\n');
    expect(restoreOut).not.toMatch(/RMAN-06023/);
    rman2.subShell.dispose();
    expect(sh(srv, `ls ${USERS_DBF}`)).toContain('users01.dbf');

    const openOut = sql.processLine('ALTER DATABASE OPEN;').output.join('\n');
    expect(openOut).not.toMatch(/ORA-01157/);
    expect(db.instance.state).toBe('OPEN');
    sql.dispose();
  });
});
