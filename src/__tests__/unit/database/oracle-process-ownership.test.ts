/**
 * Oracle background processes ↔ OS credentials coherence.
 *
 * Oracle's background processes (pmon, smon, dbwr, lgwr, …) run as the
 * `oracle` user. Previously they were registered in the host process
 * table with a hardcoded uid of 1 (the `daemon` account) — so `ps`
 * showed the owner string "oracle" but a uid that belonged to a
 * different account. Now that the oracle account is provisioned for real
 * (uid 54321), the process credentials must match it.
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

function pmonRow(psOutput: string): string | undefined {
  return psOutput.split('\n').find((l) => l.includes('ora_pmon'));
}

describe('Oracle background processes carry the real oracle uid', () => {
  it('ps shows ora_pmon owned by the oracle account (uid 54321)', async () => {
    const srv = new LinuxServer('linux-server', 'ora-proc1', 100, 100);
    getOracleDatabase(srv.getId());
    const out = await srv.executeCommand('ps -eo uid,user,comm');
    const row = pmonRow(out);
    expect(row).toBeDefined();
    expect(row).toContain('oracle');
    expect(row).toContain('54321');
    // The old bug stamped these as the daemon account (uid 1).
    expect(row).not.toMatch(/\b1\s+daemon\b/);
  });

  it('the uid matches the provisioned oracle user', async () => {
    const srv = new LinuxServer('linux-server', 'ora-proc2', 100, 100);
    getOracleDatabase(srv.getId());
    const oracleUid = (await srv.executeCommand('id -u oracle')).trim();
    const out = await srv.executeCommand('ps -eo uid,comm');
    const row = pmonRow(out);
    expect(row).toBeDefined();
    expect(row!.trim().startsWith(oracleUid)).toBe(true);
  });
});
