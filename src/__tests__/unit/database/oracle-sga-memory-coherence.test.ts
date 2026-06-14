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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function sharedMib(srv: LinuxServer): number {
  const out = sh(srv, 'free -m');
  const memLine = out.split('\n').find(l => l.startsWith('Mem:')) ?? '';
  const cols = memLine.trim().split(/\s+/);
  return Number(cols[4]);
}

describe('the SGA shows up as shared memory in the host', () => {
  it('opening the instance reserves ~512M of shared memory', () => {
    const srv = new LinuxServer('linux-server', 'sga-1', 100, 100);
    const before = sharedMib(srv);
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
    const after = sharedMib(srv);
    expect(after - before).toBeGreaterThanOrEqual(500);
  });

  it('shutting the instance down releases the SGA', () => {
    const srv = new LinuxServer('linux-server', 'sga-2', 100, 100);
    const baseline = sharedMib(srv);
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const open = sharedMib(srv);
    expect(open).toBeGreaterThan(baseline);
    sql.processLine('SHUTDOWN IMMEDIATE');
    expect(sharedMib(srv)).toBe(baseline);
    sql.dispose();
  });

  it('does not double-count across a STARTUP/SHUTDOWN cycle', () => {
    const srv = new LinuxServer('linux-server', 'sga-3', 100, 100);
    const baseline = sharedMib(srv);
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const firstOpen = sharedMib(srv);
    sql.processLine('SHUTDOWN IMMEDIATE');
    sql.processLine('STARTUP');
    const secondOpen = sharedMib(srv);
    expect(secondOpen).toBe(firstOpen);
    sql.processLine('SHUTDOWN IMMEDIATE');
    expect(sharedMib(srv)).toBe(baseline);
    sql.dispose();
  });
});
