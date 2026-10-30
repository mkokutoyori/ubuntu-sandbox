/*
 * pgrep and pkill ignored an unknown option: `pgrep --zorglub x` and `pkill
 * -Z x` printed nothing and exited 0 (pkill would even have killed on a
 * mistyped option). procps-ng prints the getopt line, a blank line and its
 * usage block on stderr, status 2. The text and statuses below were compared
 * with the real pgrep and pkill of the dev container (procps-ng 4.0.4;
 * Ubuntu 22.04 ships 3.3.17 whose block may differ). pkill's block ends with
 * `see pgrep(1)`, as printed by the real binary.
 *
 * Signals typed as options (`pkill -9 x`, `pkill -HUP x`) are operands for
 * the guard, as they are for procps.
 *
 * Measured with `git stash`: 8 cases, 4 fall before the change (the
 * refusals); the 4 witnesses pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('pgrep and pkill refuse what procps refuses', () => {
  it.each([
    ['pgrep --zorglub x', "pgrep: unrecognized option '--zorglub'", 'pgrep [options] <pattern>', 'For more details see pgrep(1).'],
    ['pkill --zorglub x', "pkill: unrecognized option '--zorglub'", 'pkill [options] <pattern>', 'For more details see pgrep(1).'],
  ])('`%s`', async (line, first, usage, last) => {
    const out = await pc().executeCommand(line);
    const lines = out.split('\n');
    expect(lines[0]).toBe(first);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Usage:');
    expect(lines[3]).toBe(` ${usage}`);
    expect(lines[lines.length - 1]).toBe(last);
  });
  it('a short option, with status 2', async () => {
    const out = await pc().executeCommand('pgrep -Z x; echo $?');
    expect(out.split('\n')[0]).toBe("pgrep: invalid option -- 'Z'");
    expect(out.endsWith('\n2')).toBe(true);
  });
  it('pkill -Z', async () => {
    expect((await pc().executeCommand('pkill -Z x')).split('\n')[0]).toBe("pkill: invalid option -- 'Z'");
  });
});

describe('witness: valid forms are accepted', () => {
  it.each(['pgrep -f sshd', 'pgrep -l -x init', 'pkill -9 zorgnothing', 'pkill -HUP zorgnothing'])('`%s`', async (line) => {
    const out = await pc().executeCommand(line);
    expect(out).not.toContain('unrecognized option');
    expect(out).not.toContain('invalid option');
  });
});
