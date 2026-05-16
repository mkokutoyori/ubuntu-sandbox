/**
 * Two devices running the IDENTICAL command sequence must produce data
 * with the same MEANING (the debug pc/server transcript pairs). Three
 * sources of incoherence were fixed and are guarded here:
 *
 *  1. WindowsFileSystem stamped `new Date()` per write, so same-minute
 *     files got non-deterministic sub-ms mtimes → `Sort-Object
 *     LastWriteTime` ordered ties differently per device. Now a
 *     per-FS monotonic clock preserves creation order.
 *  2. WindowsProcessManager.spawnProcess used Math.random() for
 *     handles/PM/WS → the same logical process showed different memory
 *     on pc vs server. Now seeded by name+pid (identical on both).
 *  3. PSEventLogProvider numbered RecordIds from a SHARED module
 *     global, so the 2nd device's ids were offset by the 1st device's
 *     entry count. Now a per-instance counter from a fixed base.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function shell(host: string) {
  const pc = new WindowsPC('windows-pc', host);
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

async function run(sh: ReturnType<typeof shell>, line: string) {
  return (await sh.processLine(line)).output.join('\n');
}

/** Build the SAME files on a shell, then return the sorted listing. */
async function fsScenario(sh: ReturnType<typeof shell>) {
  await run(sh, 'New-Item -Path C:\\D -ItemType Directory -Force | Out-Null');
  for (const [n, v] of [['b.txt', 'xx'], ['a.txt', 'y'], ['c.txt', 'zzz'], ['d.txt', 'w']]) {
    await run(sh, `Set-Content -Path C:\\D\\${n} -Value "${v}"`);
  }
  return run(sh, 'Get-ChildItem C:\\D | Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty Name');
}

describe('Filesystem LastWriteTime ordering is deterministic & coherent', () => {
  it('two devices, same script → identical Sort-Object LastWriteTime order', async () => {
    const a = await fsScenario(shell('WIN-A'));
    const b = await fsScenario(shell('SRV-B'));
    expect(a).toBe(b);
    // Descending by write time == reverse creation order.
    expect(a.split('\n')).toEqual(['d.txt', 'c.txt', 'a.txt', 'b.txt']);
  });

  it('re-running the same scenario is reproducible', async () => {
    const x = await fsScenario(shell('WIN-A'));
    const y = await fsScenario(shell('WIN-A'));
    expect(x).toBe(y);
  });
});

describe('Process stats are deterministic & coherent across devices', () => {
  it('same process name+pid → identical Handles/PM/WS on pc and server', async () => {
    const a = shell('WIN-A');
    const b = shell('SRV-B');
    await run(a, 'Start-Process notepad'); await run(a, 'Start-Process notepad');
    await run(b, 'Start-Process notepad'); await run(b, 'Start-Process notepad');
    const pa = await run(a, 'Get-Process -Name notepad | Sort-Object Id | Select-Object Id, WS, Handles | Format-Table');
    const pb = await run(b, 'Get-Process -Name notepad | Sort-Object Id | Select-Object Id, WS, Handles | Format-Table');
    expect(pa).toBe(pb);
  });
});

describe('Event-log RecordIds are coherent across devices', () => {
  it('the same logical entry has the same RecordId on pc and server', async () => {
    const a = shell('WIN-A');
    const b = shell('SRV-B');
    const ra = await run(a, 'Get-EventLog -LogName System -Newest 3 | Select-Object -ExpandProperty Index');
    const rb = await run(b, 'Get-EventLog -LogName System -Newest 3 | Select-Object -ExpandProperty Index');
    // Same logical entries → byte-identical RecordIds on both devices.
    expect(ra).toBe(rb);
    // Numbering starts from the fixed per-instance base (1000), not
    // offset by however many entries another device created first.
    const ids = ra.split('\n')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !Number.isNaN(n));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(n => n >= 1000)).toBe(true);
  });
});
