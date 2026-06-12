/**
 * systemd → Oracle reverse synchronisation.
 *
 * Before: `systemctl start/stop oracle-database-<SID>` only spawned or
 * killed a wrapper shell process — the Oracle engine never noticed, so
 * `systemctl stop oracle-listener-ORCL` left lsnrctl claiming the
 * listener was up while netstat showed nothing.
 *
 * Now OracleSystemdSync subscribes to the service lifecycle stream and
 * drives the real engine, with state guards making the Oracle→systemd
 * and systemd→Oracle directions converge without loops.
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

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

describe('systemctl drives the listener state machine', () => {
  it('systemctl stop oracle-listener-ORCL really stops the TNS listener', () => {
    const srv = bootOracleServer('rs1');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    expect(db.instance.listener.running).toBe(true);

    sh(srv, 'systemctl stop oracle-listener-ORCL');
    expect(db.instance.listener.running).toBe(false);
    // The whole OS view agrees: no socket, no daemon, TNS refusal.
    expect(sh(srv, 'netstat -tlnp')).not.toMatch(/:1521\b/);
    expect(db.instance.listener.attemptConnect('ORCL').ok).toBe(false);
  });

  it('systemctl start oracle-listener-ORCL brings it back', () => {
    const srv = bootOracleServer('rs2');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    sh(srv, 'systemctl stop oracle-listener-ORCL');
    expect(db.instance.listener.running).toBe(false);

    sh(srv, 'systemctl start oracle-listener-ORCL');
    expect(db.instance.listener.running).toBe(true);
    expect(sh(srv, 'netstat -tlnp')).toMatch(/:1521\b.*tnslsnr/);
    expect(db.instance.listener.attemptConnect('ORCL').ok).toBe(true);
  });
});

describe('systemctl drives the instance state machine', () => {
  it('systemctl stop oracle-database-ORCL shuts the instance down', () => {
    const srv = bootOracleServer('rs3');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    expect(db.instance.state).toBe('OPEN');

    sh(srv, 'systemctl stop oracle-database-ORCL');
    expect(db.instance.state).toBe('SHUTDOWN');
    // Background processes left the process table with the instance.
    expect(sh(srv, 'ps aux')).not.toMatch(/ora_pmon/);
    expect(db.instance.getAlertLog().join('\n')).toMatch(/Shutting down instance \(immediate\)/);
  });

  it('systemctl start oracle-database-ORCL starts it back up to OPEN', () => {
    const srv = bootOracleServer('rs4');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    sh(srv, 'systemctl stop oracle-database-ORCL');
    expect(db.instance.state).toBe('SHUTDOWN');

    sh(srv, 'systemctl start oracle-database-ORCL');
    expect(db.instance.state).toBe('OPEN');
    expect(sh(srv, 'ps aux')).toMatch(/ora_pmon/);
    expect(sh(srv, 'systemctl is-active oracle-database-ORCL').trim()).toBe('active');
  });

  it('SQL*Plus SHUTDOWN/STARTUP keep the unit state coherent (no loop)', () => {
    const srv = bootOracleServer('rs5');
    const db = getRegisteredOracleDatabase(srv.getId())!;

    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    sql.subShell.processLine('SHUTDOWN IMMEDIATE');
    expect(db.instance.state).toBe('SHUTDOWN');
    expect(sh(srv, 'systemctl is-active oracle-database-ORCL').trim()).not.toBe('active');

    sql.subShell.processLine('STARTUP');
    expect(db.instance.state).toBe('OPEN');
    expect(sh(srv, 'systemctl is-active oracle-database-ORCL').trim()).toBe('active');
    sql.subShell.dispose();
  });
});
