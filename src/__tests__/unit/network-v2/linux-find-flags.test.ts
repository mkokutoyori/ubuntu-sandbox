/**
 * `find` was missing the staples — `-iname`, `-maxdepth` /
 * `-mindepth`, `-size`, `-path` / `-ipath`, `-not` / `!`, `-print0`,
 * `-delete` — so a great number of standard one-liners would either
 * walk the whole tree (no depth limit) or silently no-op (size,
 * delete). This suite locks in each predicate against a controlled
 * /tmp/find-fixture/ tree.
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

function buildFixture(pc: LinuxPC): void {
  const exec = (pc as any).executor;
  const vfs = exec.vfs;
  vfs.mkdir('/tmp/F', 0o755, 0, 0);
  vfs.mkdir('/tmp/F/inner', 0o755, 0, 0);
  vfs.mkdir('/tmp/F/inner/deep', 0o755, 0, 0);
  vfs.writeFile('/tmp/F/Top.TXT',      'x'.repeat(100),  0, 0, 0o022);
  vfs.writeFile('/tmp/F/keep.log',     'y'.repeat(2048), 0, 0, 0o022);
  vfs.writeFile('/tmp/F/inner/m.txt',  'z'.repeat(50),   0, 0, 0o022);
  vfs.writeFile('/tmp/F/inner/m.bin',  'w'.repeat(8192), 0, 0, 0o022);
  vfs.writeFile('/tmp/F/inner/deep/x', 'q',              0, 0, 0o022);
}

describe('find -iname (case-insensitive)', () => {
  it('matches regardless of case', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const out = await pc.executeCommand('find /tmp/F -iname "*.txt"');
    const hits = out.split('\n').filter(Boolean);
    expect(hits).toContain('/tmp/F/Top.TXT');
    expect(hits).toContain('/tmp/F/inner/m.txt');
  });

  it('-name is still case-sensitive', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const out = await pc.executeCommand('find /tmp/F -name "*.txt"');
    expect(out).not.toContain('Top.TXT');
    expect(out).toContain('m.txt');
  });
});

describe('find -maxdepth / -mindepth', () => {
  it('-maxdepth 1 only returns the start dir + direct children', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -maxdepth 1'))
      .split('\n').filter(Boolean);
    expect(hits).toContain('/tmp/F');
    expect(hits).toContain('/tmp/F/inner');
    expect(hits).not.toContain('/tmp/F/inner/m.txt');
  });

  it('-mindepth 2 skips the start dir and its direct children', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -mindepth 2'))
      .split('\n').filter(Boolean);
    expect(hits).not.toContain('/tmp/F');
    expect(hits).not.toContain('/tmp/F/inner');
    expect(hits).toContain('/tmp/F/inner/m.txt');
  });
});

describe('find -size', () => {
  it('-size +1k matches files larger than 1 KB', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -size +1k'))
      .split('\n').filter(Boolean);
    expect(hits).toContain('/tmp/F/keep.log');   // 2048 B
    expect(hits).toContain('/tmp/F/inner/m.bin'); // 8192 B
    expect(hits).not.toContain('/tmp/F/Top.TXT'); // 100 B
  });

  it('-size -200c matches files smaller than 200 bytes', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -size -200c'))
      .split('\n').filter(Boolean);
    expect(hits).toContain('/tmp/F/Top.TXT');
    expect(hits).toContain('/tmp/F/inner/m.txt');
    expect(hits).toContain('/tmp/F/inner/deep/x');
    expect(hits).not.toContain('/tmp/F/keep.log');
  });
});

describe('find -path / -not', () => {
  it('-path matches against the full path', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -path "*/inner/*"'))
      .split('\n').filter(Boolean);
    expect(hits.every(h => h.includes('/inner/'))).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('-not -name inverts the name predicate', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const hits = (await pc.executeCommand('find /tmp/F -type f -not -name "*.log"'))
      .split('\n').filter(Boolean);
    expect(hits).not.toContain('/tmp/F/keep.log');
    expect(hits).toContain('/tmp/F/Top.TXT');
  });

  it('! is the synonym for -not', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const a = await pc.executeCommand('find /tmp/F -type f -not -name "*.log"');
    const b = await pc.executeCommand('find /tmp/F -type f ! -name "*.log"');
    expect(a).toBe(b);
  });
});

describe('find -print0 / -delete', () => {
  it('-print0 separates matches with NUL, not newline', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    const out = await pc.executeCommand('find /tmp/F -type f -iname "*.txt" -print0');
    // Two matches → exactly one NUL separator, no newline.
    expect(out).not.toContain('\n');
    expect(out).toContain('\0');
  });

  it('-delete removes the matched leaves', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    buildFixture(pc);
    await pc.executeCommand('find /tmp/F -type f -name "*.bin" -delete');
    const exec = (pc as any).executor;
    expect(exec.vfs.exists('/tmp/F/inner/m.bin')).toBe(false);
    // .txt files survive.
    expect(exec.vfs.exists('/tmp/F/Top.TXT')).toBe(true);
  });
});
