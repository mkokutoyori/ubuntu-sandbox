/**
 * `sort` knew only `-n` and `-r`. Every other GNU staple — `-u`,
 * `-k`, `-t`, `-f`, `-b`, `-h`, `-V`, `-M`, multi-file concatenation
 * — either silently dropped data or sorted in the wrong order.
 * This suite locks in each predicate.
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

function withFile(pc: LinuxPC, path: string, content: string): void {
  const exec = (pc as any).executor;
  exec.vfs.writeFile(path, content, 0, 0, 0o022);
}

describe('sort -u (unique)', () => {
  it('collapses adjacent duplicates after sorting', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/dups', 'banana\napple\nbanana\ncherry\napple\n');
    const out = await pc.executeCommand('sort -u /tmp/dups');
    expect(out.split('\n')).toEqual(['apple', 'banana', 'cherry']);
  });
});

describe('sort -k (key) + -t (delimiter)', () => {
  it('sorts CSV by the 2nd column numerically', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/scores',
      'alice,3\n' +
      'bob,11\n' +
      'carol,2\n' +
      'dave,21\n');
    const out = await pc.executeCommand('sort -t, -k2 -n /tmp/scores');
    expect(out.split('\n')[0]).toContain('carol');
    expect(out.split('\n').at(-1)).toContain('dave');
  });

  it('per-key options (-k 2,2n) override the global mode', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/mix',
      'a 11 hello\n' +
      'b 3 world\n' +
      'c 21 ok\n');
    // No global -n — but the key carries 'n', so column 2 sorts numerically.
    const out = await pc.executeCommand('sort -k 2,2n /tmp/mix');
    const lines = out.split('\n');
    expect(lines[0]).toContain('b 3');
    expect(lines[1]).toContain('a 11');
    expect(lines[2]).toContain('c 21');
  });
});

describe('sort -h (human numeric)', () => {
  it('sorts 1K < 2K < 1M < 1G', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/sz', '1G\n1K\n2K\n1M\n500\n');
    const out = await pc.executeCommand('sort -h /tmp/sz');
    expect(out.split('\n')).toEqual(['500', '1K', '2K', '1M', '1G']);
  });
});

describe('sort -V (version sort)', () => {
  it('orders 1.10 after 1.9 (numeric run compared as integer)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/ver', 'v1.2\nv1.10\nv1.9\nv2.0\nv1.1\n');
    const out = await pc.executeCommand('sort -V /tmp/ver');
    expect(out.split('\n')).toEqual(['v1.1', 'v1.2', 'v1.9', 'v1.10', 'v2.0']);
  });
});

describe('sort -M (month sort)', () => {
  it('orders abbreviated month names by calendar order', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/months', 'Mar\nJan\nDec\nApr\nFeb\n');
    const out = await pc.executeCommand('sort -M /tmp/months');
    expect(out.split('\n')).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'Dec']);
  });
});

describe('sort -f (case-insensitive)', () => {
  it('groups "Apple" and "apple" together', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/case', 'banana\nApple\ncherry\napple\n');
    const out = await pc.executeCommand('sort -f /tmp/case');
    const lines = out.split('\n');
    // The two apples must be adjacent.
    const aIdx = lines.findIndex(l => /apple/i.test(l));
    expect(/apple/i.test(lines[aIdx + 1] ?? '')).toBe(true);
  });
});

describe('sort multi-file concatenation', () => {
  it('reads every file before sorting (was reading only the first)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/a', 'beta\nalpha\n');
    withFile(pc, '/tmp/b', 'gamma\ndelta\n');
    const out = await pc.executeCommand('sort /tmp/a /tmp/b');
    expect(out.split('\n')).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });
});
