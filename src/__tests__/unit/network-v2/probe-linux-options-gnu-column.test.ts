/*
 * column (util-linux) ignored an unknown option: `column --zorglub` printed
 * nothing and status 0. util-linux reports through errtryhelp: the getopt line
 * and `Try 'column --help' for more information.`, status 1. The option table
 * is util-linux 2.37's from memory (man page not reachable), on the reader in
 * commands/Getopt.ts; only options I am sure of are listed, so a rarely used
 * long option could be refused wrongly.
 *
 * Measured with `git stash`: 5 cases, 3 fall before the change (the two
 * refusals and `--table --separator :`, whose separator was read as a file);
 * the 2 witnesses (-t, -s: -t) pass either way. column now reads its options
 * with the guard table; options accepted without effect (-o -c -x -J ...) are in TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('column refuses what it does not know', () => {
  it('a long option', async () => {
    expect(await pc().executeCommand('column --zorglub'))
      .toBe("column: unrecognized option '--zorglub'\nTry 'column --help' for more information.");
  });
  it('a short option, with status 1', async () => {
    expect(await pc().executeCommand('column -Z; echo $?'))
      .toBe("column: invalid option -- 'Z'\nTry 'column --help' for more information.\n1");
  });
});

describe('witness: known options still work', () => {
  it('-t aligns', async () => {
    expect(await pc().executeCommand('printf "a b\\nc d\\n" | column -t')).toBe('a  b\nc  d');
  });
  it('-s -t', async () => {
    expect(await pc().executeCommand('printf "a:b\\n" | column -s: -t')).toBe('a  b');
  });
  it('--table --separator', async () => {
    expect(await pc().executeCommand('printf "a:b\\n" | column --table --separator :')).toBe('a  b');
  });
});
