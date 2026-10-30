/*
 * lsattr ignored an unknown option: `lsattr --zorglub f` and `lsattr -Q f`
 * listed the file. e2fsprogs reads its options with a plain getopt (no long
 * options), so `--zorglub` fails on its first character: `lsattr: invalid
 * option -- '-'` then `Usage: lsattr [-RVadlpv] [files...]`, status 1. Both
 * outputs were compared with the real lsattr of the dev container.
 *
 * Measured with `git stash`: 4 cases, 2 fall before the change (the two
 * refusals); the 2 witnesses (-a, -d) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('lsattr refuses what e2fsprogs refuses', () => {
  it('a long option fails on its first character', async () => {
    expect(await pc().executeCommand('lsattr --zorglub /etc/hostname; echo $?'))
      .toBe("lsattr: invalid option -- '-'\nUsage: lsattr [-RVadlpv] [files...]\n1");
  });
  it('a short option', async () => {
    expect(await pc().executeCommand('lsattr -Q /etc/hostname'))
      .toBe("lsattr: invalid option -- 'Q'\nUsage: lsattr [-RVadlpv] [files...]");
  });
});

describe('witness: known options still work', () => {
  it.each(['lsattr -a /etc', 'lsattr -d /etc/hostname'])('`%s`', async (line) => {
    const out = await pc().executeCommand(line);
    expect(out).not.toContain('invalid option');
    expect(out).toContain('/etc');
  });
});
