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

function memCols(line: string): { total: number; free: number; used: number } {
  const m = line.match(/(\d+)\.0 total,\s+(\d+)\.0 free,\s+(\d+)\.0 used/);
  return { total: Number(m?.[1]), free: Number(m?.[2]), used: Number(m?.[3]) };
}

describe('top reports the live host memory (consistent with free)', () => {
  it('top and free agree on used/free/total', () => {
    const srv = new LinuxServer('linux-server', 'topmem-1', 100, 100);
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();

    const topMem = memCols(sh(srv, 'top').split('\n').find(l => l.includes('MiB Mem')) ?? '');
    const freeLine = (sh(srv, 'free -m').split('\n').find(l => l.startsWith('Mem:')) ?? '')
      .trim().split(/\s+/);
    expect(topMem.total).toBe(Number(freeLine[1]));
    expect(topMem.used).toBe(Number(freeLine[2]));
    expect(topMem.free).toBe(Number(freeLine[3]));
  });

  it('the SGA reservation moves top used up while the instance runs', () => {
    const srv = new LinuxServer('linux-server', 'topmem-2', 100, 100);
    const baseline = memCols(sh(srv, 'top').split('\n').find(l => l.includes('MiB Mem')) ?? '');
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const open = memCols(sh(srv, 'top').split('\n').find(l => l.includes('MiB Mem')) ?? '');
    expect(open.used - baseline.used).toBeGreaterThanOrEqual(500);
    sql.processLine('SHUTDOWN IMMEDIATE');
    const closed = memCols(sh(srv, 'top').split('\n').find(l => l.includes('MiB Mem')) ?? '');
    expect(closed.used).toBe(baseline.used);
    sql.dispose();
  });
});
