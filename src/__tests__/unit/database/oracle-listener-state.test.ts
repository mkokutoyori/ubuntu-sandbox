/**
 * Stateful TNS listener (ListenerControl): dynamic service registration
 * derived from the live instance state, real connection counters, and
 * the @connect_identifier error ladder (ORA-12541 / 12514 / 12528).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
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

describe('ListenerControl service registration', () => {
  it('advertises no services while the instance is down', () => {
    const db = new OracleDatabase();
    db.instance.startListener();
    expect(db.instance.listener.serviceStatus()).toBeNull();
    expect(db.instance.getListenerStatus()).toContain('The listener supports no services');
  });

  it('service is BLOCKED in NOMOUNT/MOUNT and READY once OPEN', () => {
    const db = new OracleDatabase();
    db.instance.startListener();
    db.instance.startup('NOMOUNT');
    expect(db.instance.listener.serviceStatus()).toBe('BLOCKED');
    db.instance.mountDatabase();
    expect(db.instance.listener.serviceStatus()).toBe('BLOCKED');
    db.instance.openDatabase();
    expect(db.instance.listener.serviceStatus()).toBe('READY');
    expect(db.instance.getListenerStatus()).toContain('status READY');
  });

  it('uptime and start date come from the real listener start', () => {
    const db = new OracleDatabase();
    db.instance.startup('OPEN');
    db.instance.startListener();
    const status = db.instance.getListenerStatus();
    expect(status).toMatch(/Uptime\s+0 days 0 hr\. 0 min\. \d+ sec/);
  });
});

describe('@connect_identifier goes through the listener', () => {
  function session(name: string): SqlPlusSubShell {
    const srv = new LinuxServer('linux-server', name, 100, 100);
    return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  }
  function run(sh: SqlPlusSubShell, sql: string): string {
    return sh.processLine(sql).output.join('\n');
  }
  function prepareUser(sh: SqlPlusSubShell): void {
    run(sh, 'CREATE USER app IDENTIFIED BY secret;');
    run(sh, 'GRANT CREATE SESSION TO app;');
  }

  it('fails with ORA-12541 when the listener is stopped', () => {
    const sh = session('lsn1');
    prepareUser(sh);
    const db = (sh as unknown as { session: { db: OracleDatabase } }).session.db;
    db.instance.stopListener(); // provisioning auto-starts it
    expect(run(sh, 'CONNECT app/secret@ORCL')).toContain('ORA-12541');
    sh.dispose();
  });

  it('connects and counts established once the listener runs', () => {
    const sh = session('lsn2');
    prepareUser(sh);
    const db = (sh as unknown as { session: { db: OracleDatabase } }).session.db;
    db.instance.startListener();
    expect(run(sh, 'CONNECT app/secret@ORCL')).toContain('Connected');
    expect(db.instance.listener.established).toBe(1);
    sh.dispose();
  });

  it('unknown service yields ORA-12514 and counts a refusal', () => {
    const sh = session('lsn3');
    prepareUser(sh);
    const db = (sh as unknown as { session: { db: OracleDatabase } }).session.db;
    db.instance.startListener();
    expect(run(sh, 'CONNECT app/secret@NOPE')).toContain('ORA-12514');
    expect(db.instance.listener.refused).toBe(1);
    sh.dispose();
  });

  it('local bequeath connection works without any listener', () => {
    const sh = session('lsn4');
    prepareUser(sh);
    expect(run(sh, 'CONNECT app/secret')).toContain('Connected');
    sh.dispose();
  });
});
