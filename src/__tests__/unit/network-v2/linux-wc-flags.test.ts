/**
 * `wc` was missing `-m` (chars), `-L` (max line length), the multi-file
 * total row, and the canonical 7-wide right-aligned column format
 * (real coreutils pads each count to 7 chars). The line count was also
 * derived from "number of array entries after split(\n)" which
 * conflated a no-trailing-newline file with a one-too-many count.
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

function withFile(pc: LinuxPC, p: string, c: string) {
  (pc as any).executor.vfs.writeFile(p, c, 0, 0, 0o022);
}

describe('wc — POSIX line counting', () => {
  it('counts the number of `\\n` bytes (not split-array length)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/three', 'a\nb\nc\n');   // 3 lines
    withFile(pc, '/tmp/notnl', 'a\nb\nc');     // 2 newlines → 2 lines
    const a = await pc.executeCommand('wc -l /tmp/three');
    const b = await pc.executeCommand('wc -l /tmp/notnl');
    expect(a.trim().split(/\s+/)[0]).toBe('3');
    expect(b.trim().split(/\s+/)[0]).toBe('2');
  });
});

describe('wc -m (chars) and -L (max line length)', () => {
  it('-m counts characters', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/m', 'abc\ndef\n'); // 8 chars including 2 \n
    const out = await pc.executeCommand('wc -m /tmp/m');
    expect(out.trim().split(/\s+/)[0]).toBe('8');
  });

  it('-L reports the longest line', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/lon', 'short\na bit longer\nshort again\n');
    const out = await pc.executeCommand('wc -L /tmp/lon');
    expect(out.trim().split(/\s+/)[0]).toBe('12'); // "a bit longer"
  });
});

describe('wc combined short flags + multi-file total', () => {
  it('-lw expands to -l -w', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/x', 'one two three\nfour five\n');
    const a = await pc.executeCommand('wc -lw /tmp/x');
    const b = await pc.executeCommand('wc -l -w /tmp/x');
    expect(a).toBe(b);
  });

  it('emits a "total" row when given more than one file', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/a', 'one\ntwo\n');
    withFile(pc, '/tmp/b', 'three\nfour\nfive\n');
    const out = await pc.executeCommand('wc /tmp/a /tmp/b');
    const lines = out.split('\n');
    expect(lines.at(-1)).toMatch(/\btotal$/);
    // Total line count: 2 + 3.
    const totalCols = lines.at(-1)!.trim().split(/\s+/);
    expect(totalCols[0]).toBe('5');
  });

  it('reports a friendly error per missing file but keeps going', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/exists', 'hello\n');
    const out = await pc.executeCommand('wc /tmp/exists /tmp/nope');
    expect(out).toContain('wc: /tmp/nope: No such file or directory');
    expect(out).toMatch(/\/tmp\/exists/);
  });
});
