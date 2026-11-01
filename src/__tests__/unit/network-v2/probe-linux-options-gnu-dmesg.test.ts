/*
 * dmesg (util-linux) ignored an unknown option: `dmesg --zorglub` and `dmesg
 * -Q` printed the whole ring buffer. util-linux reports through errtryhelp:
 * the getopt line and `Try 'dmesg --help' for more information.`, status 1.
 * The table is util-linux 2.37's from memory (man page not reachable); it
 * lists every option I know of, so a rare one could be refused wrongly.
 *
 * Measured with `git stash`: 8 cases, 3 fall before the change (long and
 * short refusals, and an operand, which dmesg does not take); the 5
 * witnesses (-T, -H, -l err, --level=err, -x) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('dmesg refuses what it does not know', () => {
  it('a long option', async () => {
    expect(await pc().executeCommand('sudo dmesg --zorglub'))
      .toBe("dmesg: unrecognized option '--zorglub'\nTry 'dmesg --help' for more information.");
  });
  it('a short option, with status 1', async () => {
    expect(await pc().executeCommand('sudo dmesg -Q; echo $?'))
      .toBe("dmesg: invalid option -- 'Q'\nTry 'dmesg --help' for more information.\n1");
  });
  it('an operand', async () => {
    expect(await pc().executeCommand('sudo dmesg zorglub'))
      .toBe("dmesg: extra operand 'zorglub'\nTry 'dmesg --help' for more information.");
  });
});

describe('witness: known options still work', () => {
  it.each(['dmesg -T', 'dmesg -H', 'dmesg -l err', 'dmesg --level=err', 'dmesg -x'])('`%s`', async (line) => {
    expect(await pc().executeCommand(`${line}; echo $?`)).not.toContain('unrecognized option');
    expect(await pc().executeCommand(`${line}; echo $?`)).not.toContain('invalid option');
  });
});
