/**
 * Test-Connection — `-Count N` must emit N reply rows.
 *
 * Bug from debug-output/ps-network-server_results_debug.txt:
 *
 *     PS> Test-Connection 127.0.0.1 -Count 2 -ErrorAction SilentlyContinue
 *       Source     Destination  IPV4Address  Bytes  Time(ms)  Status
 *       SRV...     127.0.0.1    127.0.0.1    32     1         Success
 *
 * Only ONE row is shown even though -Count was 2. The simulator can't
 * actually ping itself across the simulated network, so we fall back to
 * a synthetic row — but the fallback ignored -Count.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPS(): PowerShellExecutor {
  const pc = new WindowsPC('windows-pc', 'WIN-PING');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

function countSuccessRows(out: string): number {
  return out.split('\n').filter((l) => /\bSuccess\s*$/.test(l)).length;
}

describe('Test-Connection -Count', () => {
  it('-Count 1 emits 1 success row to localhost', async () => {
    const ps = createPS();
    const out = await ps.execute('Test-Connection localhost -Count 1');
    expect(countSuccessRows(out)).toBe(1);
  });

  it('-Count 2 emits 2 success rows to localhost', async () => {
    const ps = createPS();
    const out = await ps.execute('Test-Connection 127.0.0.1 -Count 2');
    expect(countSuccessRows(out)).toBe(2);
  });

  it('-Count 4 emits 4 success rows to 127.0.0.1', async () => {
    const ps = createPS();
    const out = await ps.execute('Test-Connection 127.0.0.1 -Count 4');
    expect(countSuccessRows(out)).toBe(4);
  });

  it('default (no -Count) emits 4 rows to localhost', async () => {
    const ps = createPS();
    const out = await ps.execute('Test-Connection localhost');
    expect(countSuccessRows(out)).toBe(4);
  });
});
