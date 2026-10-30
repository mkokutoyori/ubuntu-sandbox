/*
 * Twelfth step of the GNU option guard: yes, cksum, sync, expand, unexpand,
 * nice and nohup ignored an unknown option (`yes --zorglub` printed the
 * string, `expand --zorglub` read it as a file). Coreutils 8.32 (Ubuntu 22.04)
 * answers `<cmd>: unrecognized option '--zorglub'` and the `Try` line;
 * nice and nohup exit 125, the others 1. Their option tables are coreutils',
 * from memory, on the reader in commands/Getopt.ts.
 *
 * Second defect, found with the same probe: a refusal of a command listed in
 * RAW_STDOUT_COMMANDS (yes, base64, nice, ...) lost its trailing newline
 * because it was returned as stdout; it now travels as stderr, so the next
 * command of the line starts on its own line and `2>/dev/null` silences it.
 *
 * Measured with `git stash`: 13 cases, 10 fall before the change (7 refusals,
 * the newline case, the 2>/dev/null case, nice -z; the exit statuses 125 are inside the nice/nohup cases);
 * the 3 witnesses pass either way (valid options still accepted).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('an unknown option is refused in coreutils words', () => {
  it.each(['yes', 'cksum', 'sync', 'expand', 'unexpand'])('`%s --zorglub`', async (command) => {
    expect(await pc().executeCommand(`${command} --zorglub`))
      .toBe(`${command}: unrecognized option '--zorglub'\nTry '${command} --help' for more information.`);
  });

  it.each(['nice', 'nohup'])('`%s --zorglub` exits 125', async (command) => {
    expect(await pc().executeCommand(`${command} --zorglub; echo $?`))
      .toBe(`${command}: unrecognized option '--zorglub'\nTry '${command} --help' for more information.\n125`);
  });

  it('nice -z is an invalid short option', async () => {
    expect(await pc().executeCommand('nice -z; echo $?'))
      .toBe("nice: invalid option -- 'z'\nTry 'nice --help' for more information.\n125");
  });
});

describe('the refusal is a stderr line', () => {
  it('starts the next command on its own line', async () => {
    expect(await pc().executeCommand('yes --zorglub; echo next'))
      .toBe("yes: unrecognized option '--zorglub'\nTry 'yes --help' for more information.\nnext");
  });

  it('is silenced by 2>/dev/null', async () => {
    expect(await pc().executeCommand('yes --zorglub 2>/dev/null; echo next')).toBe('next');
  });
});

describe('witness: valid forms are untouched', () => {
  it('nice -n 5 runs its command', async () => {
    expect(await pc().executeCommand('nice -n 5 echo hi')).toBe('hi');
  });
  it('expand -t 4 reads its file', async () => {
    expect(await pc().executeCommand('expand -t 4 /etc/hostname')).toBe('PC1');
  });
  it('yes still feeds a pipe', async () => {
    expect(await pc().executeCommand('yes | head -2')).toBe('y\ny');
  });
});
