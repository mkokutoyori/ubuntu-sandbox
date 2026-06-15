/**
 * Oracle `AS SYSDBA` OS-authentication coherence.
 *
 * Real Oracle grants SYSDBA via OS authentication only to privileged
 * users: the superuser, the OSDBA group (`dba`), or — in this simulator —
 * the host administrators (`sudo`), who can become the Oracle owner.
 * Previously the SQL*Plus layer always connected with a hardcoded
 * DEFAULT_OS_CONTEXT (isDbaGroup=true), so `/ as sysdba` succeeded for
 * everyone regardless of group membership.
 *
 * Now the session derives its OS security context from the host's real
 * /etc/passwd + /etc/group, so the check is grounded in actual membership.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  getOracleDatabase,
  createSQLPlusSession,
  resetAllOracleInstances,
} from '@/terminal/commands/database';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function sysdbaLogin(srv: LinuxServer, osUser: string): string {
  const { loginOutput } = createSQLPlusSession(srv.getId(), ['/', 'as', 'sysdba'], osUser);
  return loginOutput.join('\n');
}

describe('AS SYSDBA requires real OSDBA (dba) membership', () => {
  it('the oracle user (member of dba) connects', () => {
    const srv = new LinuxServer('linux-server', 'ora-sd1', 100, 100);
    getOracleDatabase(srv.getId()); // provisions oracle:oinstall + dba
    expect(sysdbaLogin(srv, 'oracle')).toContain('Connected.');
  });

  it('root (superuser) connects', () => {
    const srv = new LinuxServer('linux-server', 'ora-sd2', 100, 100);
    getOracleDatabase(srv.getId());
    expect(sysdbaLogin(srv, 'root')).toContain('Connected.');
  });

  it('an unprivileged user (no dba/sudo) is refused with ORA-01031', async () => {
    const srv = new LinuxServer('linux-server', 'ora-sd3', 100, 100);
    getOracleDatabase(srv.getId());
    // A plain useradd lands the user in a private group only — neither dba
    // nor sudo — so SYSDBA OS-auth must be refused.
    await srv.executeCommand('useradd appuser');
    const out = sysdbaLogin(srv, 'appuser');
    expect(out).toContain('ORA-01031');
    expect(out).not.toContain('Connected.');
  });

  it('a user added to dba afterwards is then allowed', async () => {
    const srv = new LinuxServer('linux-server', 'ora-sd4', 100, 100);
    getOracleDatabase(srv.getId());
    await srv.executeCommand('useradd carol');
    expect(sysdbaLogin(srv, 'carol')).toContain('ORA-01031');
    await srv.executeCommand('usermod -aG dba carol');
    expect(sysdbaLogin(srv, 'carol')).toContain('Connected.');
  });
});
