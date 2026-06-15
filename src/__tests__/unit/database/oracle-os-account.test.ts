/**
 * Oracle ↔ Linux OS identity coherence.
 *
 * A real Oracle deployment runs under a dedicated `oracle` OS user that
 * belongs to the `oinstall` (primary) and `dba` groups. Membership of
 * `dba` is what authorises `sqlplus / as sysdba`, and the user owns the
 * datafiles and background processes. Before this, the `oracle` user was
 * only a hardcoded label — it had no `/etc/passwd` / `/etc/group` entry,
 * so the systemd `User=oracle` units and SYSDBA checks were ungrounded.
 *
 * Bringing Oracle up on a host must therefore provision that identity for
 * real, the way an installer would.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

describe('Oracle OS account provisioning', () => {
  it('does not exist before Oracle is brought up', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc0', 100, 100);
    const out = await srv.executeCommand('id oracle');
    expect(out).toMatch(/no such user|cannot find/i);
  });

  it('creates the oracle user once Oracle is set up', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc1', 100, 100);
    getOracleDatabase(srv.getId());
    const passwd = await srv.executeCommand('getent passwd oracle');
    expect(passwd).toContain('oracle');
    expect(passwd).toContain('54321');
    expect(passwd).toContain('/u01/app/oracle');
    expect(passwd).toContain('/bin/bash');
  });

  it('creates the oinstall and dba groups', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc2', 100, 100);
    getOracleDatabase(srv.getId());
    expect(await srv.executeCommand('getent group oinstall')).toContain('54321');
    expect(await srv.executeCommand('getent group dba')).toContain('54322');
  });

  it('puts oracle in oinstall (primary) and dba (supplementary)', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc3', 100, 100);
    getOracleDatabase(srv.getId());
    const id = await srv.executeCommand('id oracle');
    expect(id).toContain('oinstall');
    expect(id).toContain('dba');
  });

  it('is idempotent — re-resolving the database does not error or duplicate', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc4', 100, 100);
    getOracleDatabase(srv.getId());
    getOracleDatabase(srv.getId());
    const passwd = await srv.executeCommand('getent passwd oracle');
    // Exactly one oracle line.
    const matches = passwd.split('\n').filter((l) => l.startsWith('oracle:'));
    expect(matches).toHaveLength(1);
  });

  it('grounds the systemd User=oracle unit in a real account', async () => {
    const srv = new LinuxServer('linux-server', 'ora-acc5', 100, 100);
    getOracleDatabase(srv.getId());
    // The user referenced by the oracle systemd units now resolves.
    const id = await srv.executeCommand('id -u oracle');
    expect(id.trim()).toBe('54321');
  });
});
