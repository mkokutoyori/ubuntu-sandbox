/**
 * Instance lifecycle fidelity: ALTER DATABASE MOUNT/OPEN drive the real
 * NOMOUNT → MOUNT → OPEN state machine (ORA-01100/01507/01531 on illegal
 * transitions), and RESTRICTED SESSION mode is actually enforced at
 * logon (ORA-01035) — by STARTUP RESTRICT and ALTER SYSTEM ENABLE/DISABLE
 * RESTRICTED SESSION.
 */
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

function session(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
async function run(sh: SqlPlusSubShell, sql: string): Promise<string> {
  return (await sh.processLine(sql)).output.join('\n');
}

describe('ALTER DATABASE state machine', () => {
  it('walks NOMOUNT → MOUNT → OPEN manually', async () => {
    const sh = session('sm1');
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    (await run(sh, 'STARTUP NOMOUNT'));
    expect((await run(sh, 'SELECT status FROM v$instance;'))).toContain('STARTED');
    expect((await run(sh, 'ALTER DATABASE MOUNT;'))).toContain('Database altered.');
    expect((await run(sh, 'SELECT status FROM v$instance;'))).toContain('MOUNTED');
    expect((await run(sh, 'ALTER DATABASE OPEN;'))).toContain('Database altered.');
    expect((await run(sh, 'SELECT status FROM v$instance;'))).toContain('OPEN');
    sh.dispose();
  });

  it('MOUNT when already mounted/open raises ORA-01100', async () => {
    const sh = session('sm2');
    expect((await run(sh, 'ALTER DATABASE MOUNT;'))).toContain('ORA-01100');
    sh.dispose();
  });

  it('OPEN when already open raises ORA-01531', async () => {
    const sh = session('sm3');
    expect((await run(sh, 'ALTER DATABASE OPEN;'))).toContain('ORA-01531');
    sh.dispose();
  });

  it('OPEN from NOMOUNT raises ORA-01507 (mount first)', async () => {
    const sh = session('sm4');
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    (await run(sh, 'STARTUP NOMOUNT'));
    expect((await run(sh, 'ALTER DATABASE OPEN;'))).toContain('ORA-01507');
    sh.dispose();
  });
});

describe('RESTRICTED SESSION enforcement', () => {
  async function createAppUser(sh: SqlPlusSubShell): Promise<void> {
    (await run(sh, 'CREATE USER app IDENTIFIED BY secret;'));
    (await run(sh, 'GRANT CREATE SESSION TO app;'));
  }

  it('STARTUP RESTRICT blocks normal users with ORA-01035', async () => {
    const sh = session('rs1');
    (await createAppUser(sh));
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    (await run(sh, 'STARTUP RESTRICT'));
    expect((await run(sh, 'SELECT logins FROM v$instance;'))).toContain('RESTRICTED');
    expect((await run(sh, 'CONNECT app/secret'))).toContain('ORA-01035');
    sh.dispose();
  });

  it('users holding RESTRICTED SESSION may still log on', async () => {
    const sh = session('rs2');
    (await createAppUser(sh));
    (await run(sh, 'GRANT RESTRICTED SESSION TO app;'));
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    (await run(sh, 'STARTUP RESTRICT'));
    expect((await run(sh, 'CONNECT app/secret'))).toContain('Connected');
    sh.dispose();
  });

  it('ALTER SYSTEM ENABLE/DISABLE RESTRICTED SESSION toggles enforcement', async () => {
    const sh = session('rs3');
    (await createAppUser(sh));
    (await run(sh, 'ALTER SYSTEM ENABLE RESTRICTED SESSION;'));
    expect((await run(sh, 'SELECT logins FROM v$instance;'))).toContain('RESTRICTED');
    expect((await run(sh, 'CONNECT app/secret'))).toContain('ORA-01035');
    (await run(sh, 'CONNECT / AS SYSDBA'));
    (await run(sh, 'ALTER SYSTEM DISABLE RESTRICTED SESSION;'));
    expect((await run(sh, 'CONNECT app/secret'))).toContain('Connected');
    sh.dispose();
  });

  it('restricted mode does not survive a bounce without RESTRICT', async () => {
    const sh = session('rs4');
    (await createAppUser(sh));
    (await run(sh, 'ALTER SYSTEM ENABLE RESTRICTED SESSION;'));
    (await run(sh, 'SHUTDOWN IMMEDIATE'));
    (await run(sh, 'STARTUP'));
    expect((await run(sh, 'SELECT logins FROM v$instance;'))).toContain('ALLOWED');
    expect((await run(sh, 'CONNECT app/secret'))).toContain('Connected');
    sh.dispose();
  });
});
