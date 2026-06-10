/**
 * `cut` only understood `-d` and `-f` as comma-separated single
 * numbers — no ranges, no `-c` (characters), no `-b` (bytes), no
 * `-s` (skip undelimited lines), no `--complement`, no
 * `--output-delimiter`. So `cut -d, -f1-3 file.csv` returned nothing
 * (range syntax wasn't parsed) and `cut -c1-5` was ignored entirely.
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

describe('cut -f with range syntax', () => {
  it('-f1-3 keeps columns 1..3', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c,d,e\nA,B,C,D,E\n');
    const out = await pc.executeCommand('cut -d, -f1-3 /tmp/c');
    expect(out).toBe('a,b,c\nA,B,C');
  });

  it('-f2- keeps columns 2..end', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c,d\n');
    const out = await pc.executeCommand('cut -d, -f2- /tmp/c');
    expect(out).toBe('b,c,d');
  });

  it('-f-2 keeps columns 1..2', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c,d\n');
    const out = await pc.executeCommand('cut -d, -f-2 /tmp/c');
    expect(out).toBe('a,b');
  });

  it('-f1,3,5 keeps non-contiguous columns', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c,d,e\n');
    const out = await pc.executeCommand('cut -d, -f1,3,5 /tmp/c');
    expect(out).toBe('a,c,e');
  });
});

describe('cut -c (characters) and -b (bytes)', () => {
  it('-c1-3 keeps the first three characters of each line', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'abcdef\n123456\n');
    const out = await pc.executeCommand('cut -c1-3 /tmp/c');
    expect(out).toBe('abc\n123');
  });

  it('-c5- keeps characters 5..end', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'abcdefghij\n');
    const out = await pc.executeCommand('cut -c5- /tmp/c');
    expect(out).toBe('efghij');
  });

  it('-b mirrors -c on ASCII data', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'abcdef\n');
    const a = await pc.executeCommand('cut -c1-3 /tmp/c');
    const b = await pc.executeCommand('cut -b1-3 /tmp/c');
    expect(a).toBe(b);
  });
});

describe('cut -s and --output-delimiter / --complement', () => {
  it('-s skips lines without the delimiter', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'one,two\nnodelimhere\nthree,four\n');
    const out = await pc.executeCommand('cut -d, -f1 -s /tmp/c');
    expect(out).toBe('one\nthree');
  });

  it('--output-delimiter rewrites the separator', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c\n');
    const out = await pc.executeCommand('cut -d, -f1,3 --output-delimiter="|" /tmp/c');
    expect(out).toBe('a|c');
  });

  it('--complement inverts the field selection', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    withFile(pc, '/tmp/c', 'a,b,c,d,e\n');
    const out = await pc.executeCommand('cut -d, -f2,4 --complement /tmp/c');
    expect(out).toBe('a,c,e');
  });
});
