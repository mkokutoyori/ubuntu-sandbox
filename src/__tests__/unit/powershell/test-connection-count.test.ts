/**
 * Test-Connection — `-Count N` must emit N reply rows.
 *
 * Bug from debug-output/ps-network-server_results_debug.txt:
 *
 *     PS> Test-Connection 127.0.0.1 -Count 2 -ErrorAction SilentlyContinue
 *       Source     Destination  IPV4Address  Bytes  Time(ms)  Status
 *       SRV...     127.0.0.1    127.0.0.1    32     1         Success
 *
 * Only ONE row was shown even though -Count was 2. The migrated
 * interpreter cmdlet now respects -Count and emits N rows ending with
 * Status=Success. Routed through PowerShellSubShell so the dispatch
 * exercises the same path real users see.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN-PING');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

function countSuccessRows(out: string): number {
  return out.split('\n').filter((l) => /\bSuccess\s*$/.test(l)).length;
}

describe('Test-Connection -Count (via interpreter)', () => {
  it('-Count 1 emits 1 success row to localhost', async () => {
    const out = await run(createShell(), 'Test-Connection localhost -Count 1');
    expect(countSuccessRows(out)).toBe(1);
  });

  it('-Count 2 emits 2 success rows to localhost', async () => {
    const out = await run(createShell(), 'Test-Connection "127.0.0.1" -Count 2');
    expect(countSuccessRows(out)).toBe(2);
  });

  it('-Count 4 emits 4 success rows to 127.0.0.1', async () => {
    const out = await run(createShell(), 'Test-Connection "127.0.0.1" -Count 4');
    expect(countSuccessRows(out)).toBe(4);
  });

  it('default (no -Count) emits 4 rows to localhost', async () => {
    const out = await run(createShell(), 'Test-Connection localhost');
    expect(countSuccessRows(out)).toBe(4);
  });
});
