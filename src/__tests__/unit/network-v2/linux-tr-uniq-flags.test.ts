/**
 * `tr` ignored every flag (`-d`, `-s`, `-c`) and didn't understand the
 * POSIX `[:class:]` aliases, so `tr -d '[:space:]'` would *delete the
 * literal '[', ':', s, p…* characters. `uniq` ignored `-c`, `-d`,
 * `-u`, `-i`, `-f`, `-s`, so any non-default invocation degraded into
 * a duplicate-line collapser.
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

describe('tr — character class & flag handling', () => {
  it('[:upper:] → [:lower:] folds case', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('echo "HELLO WORLD" | tr "[:upper:]" "[:lower:]"');
    expect(out.trim()).toBe('hello world');
  });

  it('-d "[:digit:]" deletes every digit', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('echo "abc123def456" | tr -d "[:digit:]"');
    expect(out.trim()).toBe('abcdef');
  });

  it('-s squeezes repeats of the matched set', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('echo "aaabbb  ccc" | tr -s " "');
    expect(out.trim()).toBe('aaabbb ccc');
  });

  it('-c -d (complement+delete) keeps only the named set', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('echo "Phone: (555) 123-4567" | tr -cd "[:digit:]"');
    expect(out).toBe('5551234567');
  });

  it('escape sequences in SETs (\\n, \\t)', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    // Stamp a file containing a real tab + write it through `cat | tr`.
    (pc as any).executor.vfs.writeFile('/tmp/tabbed', 'a\tb\tc', 0, 0, 0o022);
    const out = await pc.executeCommand('cat /tmp/tabbed | tr "\\t" ","');
    expect(out).toBe('a,b,c');
  });
});

describe('uniq — count / dup / unique / case-insensitive', () => {
  function write(pc: LinuxPC, p: string, c: string) {
    (pc as any).executor.vfs.writeFile(p, c, 0, 0, 0o022);
  }

  it('-c prepends the run count', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    write(pc, '/tmp/u', 'a\na\nb\nc\nc\nc\n');
    const out = await pc.executeCommand('uniq -c /tmp/u');
    expect(out.split('\n').map(l => l.trim())).toEqual([
      '2 a', '1 b', '3 c',
    ]);
  });

  it('-d only emits adjacent duplicates', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    write(pc, '/tmp/u', 'a\na\nb\nc\nc\nc\n');
    const out = await pc.executeCommand('uniq -d /tmp/u');
    expect(out.split('\n')).toEqual(['a', 'c']);
  });

  it('-u only emits single-occurrence lines', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    write(pc, '/tmp/u', 'a\na\nb\nc\nc\nc\n');
    const out = await pc.executeCommand('uniq -u /tmp/u');
    expect(out.split('\n')).toEqual(['b']);
  });

  it('-i is case-insensitive', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    write(pc, '/tmp/u', 'Apple\napple\nApple\nBanana\n');
    const out = await pc.executeCommand('uniq -i /tmp/u');
    expect(out.split('\n')).toEqual(['Apple', 'Banana']);
  });

  it('-f N skips N whitespace-separated fields for comparison', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    write(pc, '/tmp/u', '1 apple\n2 apple\n3 banana\n');
    const out = await pc.executeCommand('uniq -f 1 /tmp/u');
    // After skipping field 1, lines 1 & 2 become "apple" → collapse.
    expect(out.split('\n')).toEqual(['1 apple', '3 banana']);
  });
});
