/**
 * Control file ⇄ host-filesystem coherence (ORA-00205).
 *
 * Before: STARTUP never looked at the control files. `rm control01.ctl`
 * changed nothing — worse, the next state-change sync re-wrote the file,
 * resurrecting it behind the DBA's back. A real instance reads every
 * multiplexed control file copy at MOUNT time and fails with ORA-00205
 * when any copy is missing, staying NOMOUNT.
 *
 * Now: the VFS is authoritative for control files and redo members too
 * (materialised once, like datafiles); MOUNT — via STARTUP or ALTER
 * DATABASE MOUNT — fails with ORA-00205 and logs ORA-00210/ORA-00202
 * detail to the alert log.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const CTL1 = '/u01/app/oracle/oradata/ORCL/control01.ctl';
const CTL2 = '/u01/app/oracle/oradata/ORCL/control02.ctl';

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

describe('rm of a control file follows the real Oracle failure ladder', () => {
  it('both multiplexed copies exist on the VFS after provisioning', () => {
    const srv = bootOracleServer('cf1');
    expect(sh(srv, `ls ${CTL1}`)).toContain('control01.ctl');
    expect(sh(srv, `ls ${CTL2}`)).toContain('control02.ctl');
  });

  it('a deleted control file is NOT resurrected by later instance activity', () => {
    const srv = bootOracleServer('cf2');
    sh(srv, `rm ${CTL1}`);
    const sql = sqlplus(srv);
    sql.processLine('ALTER SYSTEM SWITCH LOGFILE;'); // triggers a sync
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP');
    sql.dispose();
    expect(sh(srv, `ls ${CTL1}`)).toMatch(/No such file/);
  });

  it('STARTUP stays NOMOUNT with ORA-00205 when one copy is missing', () => {
    const srv = bootOracleServer('cf3');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    sh(srv, `rm ${CTL1}`);

    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    const out = sql.processLine('STARTUP').output.join('\n');
    sql.dispose();
    expect(out).toContain('ORACLE instance started.');
    expect(out).toContain('ORA-00205: error in identifying control file, check alert log for more info');
    expect(out).not.toContain('Database mounted.');
    expect(db.instance.state).toBe('NOMOUNT');
    const alert = db.instance.getAlertLog().join('\n');
    expect(alert).toContain('ORA-00210: cannot open the specified control file');
    expect(alert).toContain(`ORA-00202: control file: '${CTL1}'`);
  });

  it('ALTER DATABASE MOUNT raises ORA-00205 too', () => {
    const srv = bootOracleServer('cf4');
    sh(srv, `rm ${CTL2}`);
    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP NOMOUNT');
    const out = sql.processLine('ALTER DATABASE MOUNT;').output.join('\n');
    sql.dispose();
    expect(out).toContain('ORA-00205');
  });

  it('a running instance is not affected by the rm (open inode semantics)', () => {
    const srv = bootOracleServer('cf5');
    sh(srv, `rm ${CTL1}`);
    const sql = sqlplus(srv);
    const out = sql.processLine('SELECT COUNT(*) FROM hr.employees;').output.join('\n');
    sql.dispose();
    expect(out).not.toMatch(/ORA-/);
  });

  it('restoring the file (copy from the surviving copy) lets MOUNT succeed', () => {
    const srv = bootOracleServer('cf6');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    sh(srv, `rm ${CTL1}`);
    const sql = sqlplus(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    expect(sql.processLine('STARTUP').output.join('\n')).toContain('ORA-00205');
    // The canonical DBA fix: copy a surviving multiplexed copy in place.
    sh(srv, `cp ${CTL2} ${CTL1}`);
    const out = sql.processLine('ALTER DATABASE MOUNT;').output.join('\n');
    const open = sql.processLine('ALTER DATABASE OPEN;').output.join('\n');
    sql.dispose();
    expect(out).toContain('Database altered.');
    expect(open).toContain('Database altered.');
    expect(db.instance.state).toBe('OPEN');
  });
});
