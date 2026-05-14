/**
 * Get-ChildItem — Mode column formatting.
 *
 * Bug captured in debug-output/ps-filesystem_results_debug.txt:
 *
 *     PS> 1..5 | ForEach-Object { New-Item ... }
 *     ...
 *     Mode    LastWriteTime        Length  Name
 *     ------  -------------------  ------  ------------
 *     ------  5/14/2026   9:14 AM       5  bulk-1.txt
 *
 * In real PowerShell new files have the archive bit set, so Mode should
 * be `-a----`, not `------`. Same for files modified via Set-Content.
 *
 * Directories should render as `d-----`.
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
  const pc = new WindowsPC('windows-pc', 'WIN-MODE');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('Get-ChildItem — Mode column', () => {
  it('newly created file has archive bit set (-a----)', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\modeTest -ItemType Directory -Force');
    await ps.execute('New-Item -Path C:\\modeTest\\hello.txt -ItemType File -Value "hi"');
    const out = await ps.execute('Get-ChildItem C:\\modeTest');
    expect(out).toMatch(/-a----\s+.*hello\.txt/);
  });

  it('file created via Set-Content has archive bit set', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\modeTest2 -ItemType Directory -Force');
    await ps.execute('Set-Content -Path C:\\modeTest2\\note.txt -Value "x"');
    const out = await ps.execute('Get-ChildItem C:\\modeTest2');
    expect(out).toMatch(/-a----\s+.*note\.txt/);
  });

  it('directory renders as d-----', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\modeTest3 -ItemType Directory -Force');
    await ps.execute('New-Item -Path C:\\modeTest3\\sub -ItemType Directory');
    const out = await ps.execute('Get-ChildItem C:\\modeTest3');
    expect(out).toMatch(/d-----\s+.*sub/);
  });

  it('Mode column never has `------` for plain files (regression guard)', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\modeTest4 -ItemType Directory -Force');
    await ps.execute('1..3 | ForEach-Object { New-Item -Path "C:\\modeTest4\\f$_.txt" -ItemType File -Value "row $_" }');
    const out = await ps.execute('Get-ChildItem C:\\modeTest4');
    // Each file line should have `-a----`, not the bare `------`.
    const lines = out.split('\n').filter((l) => l.includes('.txt'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/-a----/);
    }
  });
});
