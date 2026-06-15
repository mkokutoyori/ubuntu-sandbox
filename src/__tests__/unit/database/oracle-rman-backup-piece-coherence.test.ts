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
const BACKUP_BASE = '/u01/backup';

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function sqlplus(srv: LinuxServer) {
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

function backupPieceFiles(srv: LinuxServer): string[] {
  const out = sh(srv, `find ${BACKUP_BASE} -type f`);
  return out.split(/\s+/).map(s => s.trim()).filter(p => p.startsWith(BACKUP_BASE));
}

describe('a healthy backup still restores (no false positives)', () => {
  it('backup → rm datafile → restore succeeds while the pieces exist', () => {
    const srv = bootOracleServer('rbp1');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup database;');
    rman.subShell.dispose();

    sh(srv, `rm ${USERS_DBF}`);
    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP');

    const rman2 = ReactiveRmanSubShell.create(srv, ['target', '/']);
    const out = rman2.subShell.processLine('restore datafile 4;').output.join('\n');
    rman2.subShell.dispose();
    expect(out).not.toMatch(/RMAN-0602[36]/);
    expect(sh(srv, `ls ${USERS_DBF}`)).toContain('users01.dbf');
    expect(sql.processLine('ALTER DATABASE OPEN;').output.join('\n')).not.toMatch(/ORA-/);
    sql.dispose();
  });
});

describe('rm of the backup pieces makes RESTORE fail like real RMAN', () => {
  it('aborts with RMAN-06026/06023 and leaves the datafile missing', () => {
    const srv = bootOracleServer('rbp2');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
    rman.subShell.processLine('backup database;');
    rman.subShell.dispose();

    const pieces = backupPieceFiles(srv);
    expect(pieces.length).toBeGreaterThan(0);

    sh(srv, `rm ${USERS_DBF}`);
    for (const p of pieces) sh(srv, `rm ${p}`);

    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP');
    expect(db.instance.state).toBe('MOUNT');

    const rman2 = ReactiveRmanSubShell.create(srv, ['target', '/']);
    const out = rman2.subShell.processLine('restore datafile 4;').output.join('\n');
    rman2.subShell.dispose();
    expect(out).toMatch(/RMAN-0602[36]/);
    expect(sh(srv, `ls ${USERS_DBF}`)).toMatch(/No such file/);
    expect(db.instance.state).toBe('MOUNT');
    sql.dispose();
  });
});
