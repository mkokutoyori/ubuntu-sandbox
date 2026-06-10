/**
 * `df` and `du` now report real numbers from the VFS instead of
 * frozen vendor strings (df) and Math.random() (du).
 *
 * Pre-fix:
 *   - `df` always returned "Used 12582912" on the / row, no matter
 *     how empty or full the filesystem actually was.
 *   - `du -s /tmp` returned "4.2M" verbatim, every invocation.
 *   - `du <dir>` listed sub-entries with sizes from Math.random() so
 *     two consecutive calls disagreed.
 *
 * Each test below would have failed against the old implementation
 * (random output, frozen totals, no actual recursion).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('df reads the real VFS', () => {
  it('Used column grows after a 5 MB file is written', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const before = parseInt((await pc.executeCommand('df'))
      .split('\n')[1]!
      .trim().split(/\s+/)[2]!, 10);
    await pc.executeCommand("dd if=/dev/zero of=/tmp/big.bin bs=1024 count=5000");
    // dd may or may not be available — fall back to writing via touch + python-style.
    // If the file didn't materialise that way, write directly via the VFS so the
    // test still exercises df.
    const exec = (pc as any).executor;
    if (!exec.vfs.exists('/tmp/big.bin')) {
      exec.vfs.writeFile('/tmp/big.bin', 'x'.repeat(5_242_880), 0, 0, 0o022);
    }
    const after = parseInt((await pc.executeCommand('df'))
      .split('\n')[1]!
      .trim().split(/\s+/)[2]!, 10);
    // Used grew by ≥5000 KB (rounding may add 1).
    expect(after - before).toBeGreaterThanOrEqual(5000);
  });

  it('Available + Used ≈ capacity for the / row', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const row = (await pc.executeCommand('df')).split('\n')[1]!;
    const fields = row.trim().split(/\s+/);
    const cap = parseInt(fields[1]!, 10);
    const used = parseInt(fields[2]!, 10);
    const avail = parseInt(fields[3]!, 10);
    expect(used + avail).toBe(cap);
  });

  it('df -h prints human-readable units on the / row', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('df -h');
    expect(out).toMatch(/\/dev\/sda1\s+50G\s+\S+[KMGT]?\s+\S+[KMGT]?\s+\d+%\s+\//);
  });

  it('df -i Used inode count tracks actual file count', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const exec = (pc as any).executor;
    const before = parseInt((await pc.executeCommand('df -i'))
      .split('\n')[1]!
      .trim().split(/\s+/)[2]!, 10);
    for (let i = 0; i < 25; i++) {
      exec.vfs.writeFile(`/tmp/seed-${i}.txt`, `${i}\n`, 0, 0, 0o022);
    }
    const after = parseInt((await pc.executeCommand('df -i'))
      .split('\n')[1]!
      .trim().split(/\s+/)[2]!, 10);
    expect(after - before).toBeGreaterThanOrEqual(25);
  });
});

describe('du computes real sizes (no Math.random)', () => {
  it('two consecutive calls return identical output', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const a = await pc.executeCommand('du /etc');
    const b = await pc.executeCommand('du /etc');
    expect(a).toBe(b);
  });

  it('du -s on a file returns its real byte count (≈)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const exec = (pc as any).executor;
    exec.vfs.writeFile('/tmp/payload.bin', 'x'.repeat(8192), 0, 0, 0o022);
    const out = await pc.executeCommand('du -s /tmp/payload.bin');
    // 8192 bytes → 8 blocks (1KB blocks).
    expect(out.trim()).toMatch(/^8\s+\/tmp\/payload\.bin$/);
  });

  it('du -sb returns exact byte count', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const exec = (pc as any).executor;
    exec.vfs.writeFile('/tmp/exact.bin', 'a'.repeat(12345), 0, 0, 0o022);
    const out = await pc.executeCommand('du -sb /tmp/exact.bin');
    expect(out.trim()).toBe('12345\t/tmp/exact.bin');
  });

  it('du -sh /etc returns a human-readable summary', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('du -sh /etc');
    expect(out.trim()).toMatch(/^\d+(\.\d+)?[BKMGT]\s+\/etc$/);
  });

  it('du recurses into subdirs (last line is the total)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const exec = (pc as any).executor;
    exec.vfs.mkdir('/tmp/tree', 0, 0, 0o022);
    exec.vfs.mkdir('/tmp/tree/inner', 0, 0, 0o022);
    exec.vfs.writeFile('/tmp/tree/inner/leaf', 'x'.repeat(2048), 0, 0, 0o022);
    const out = await pc.executeCommand('du /tmp/tree');
    const lines = out.split('\n');
    // inner directory's line precedes the /tmp/tree line.
    expect(lines.find(l => l.endsWith('/tmp/tree/inner'))).toBeTruthy();
    expect(lines[lines.length - 1]!.endsWith('/tmp/tree')).toBe(true);
  });

  it('du on a missing path returns a real error', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('du /no/such/dir');
    expect(out).toMatch(/cannot access.*No such file/);
  });
});
