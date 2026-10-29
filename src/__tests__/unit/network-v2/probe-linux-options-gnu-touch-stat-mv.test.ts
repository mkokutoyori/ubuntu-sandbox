/*
 * Thirteenth step of the GNU option guard: touch, stat, truncate, mv and
 * mkfifo answered an unknown option with something else (`touch --zorglub
 * /tmp/f` succeeded silently, `touch --zorglub` complained about a missing
 * operand, `mv --zorglub a b` complained about `a`, `stat --zorglub file`
 * printed the file). Coreutils 8.32 reads the options first and answers
 * `<cmd>: unrecognized option '--zorglub'` plus the `Try` line, status 1.
 * Tables are coreutils', from memory, on commands/Getopt.ts.
 *
 * Measured with `git stash`: 17 cases, 13 fall before the change (the six
 * refusals; `mv -v`, which was accepted and printed nothing; `stat --format=`
 * which was not read; and the five mv cases that exercise several sources,
 * -t, -n, -v with a failure and the missing-destination wording). The 4 that
 * pass either way are witnesses: touch -c/-d/-r, stat -c, truncate -s,
 * mv -n -T with mkfifo -m. mv now parses its options with the same table the
 * guard uses (gnuOptionSet('mv')), so the guard and the command cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('an unknown option is refused before operands are looked at', () => {
  it.each([
    ['touch --zorglub /tmp/f', 'touch'],
    ['touch --zorglub', 'touch'],
    ['stat --zorglub /etc/hostname', 'stat'],
    ['truncate --zorglub /tmp/f', 'truncate'],
    ['mv --zorglub /tmp/a /tmp/b', 'mv'],
    ['mkfifo --zorglub /tmp/ff', 'mkfifo'],
  ])('`%s`', async (line, command) => {
    expect(await pc().executeCommand(line))
      .toBe(`${command}: unrecognized option '--zorglub'\nTry '${command} --help' for more information.`);
  });
});

describe('witness: valid forms are accepted', () => {
  it('touch -c -d and -r', async () => {
    const machine = pc();
    expect(await machine.executeCommand('touch -c /tmp/none; touch -d "2020-01-02 03:04" /tmp/f; touch -r /tmp/f /tmp/g; ls -1 /tmp')).toBe('f\ng');
  });
  it('stat -c', async () => {
    expect(await pc().executeCommand('stat -c %n /etc/hostname')).toBe('/etc/hostname');
  });
  it('truncate -s', async () => {
    const machine = pc();
    expect(await machine.executeCommand('truncate -s 5 /tmp/t; stat -c %s /tmp/t')).toBe('5');
  });
  it('mv -v', async () => {
    const machine = pc();
    expect(await machine.executeCommand('touch /tmp/a; mv -v /tmp/a /tmp/b')).toBe("renamed '/tmp/a' -> '/tmp/b'");
  });
  it('mv -n -T and mkfifo -m', async () => {
    const machine = pc();
    expect(await machine.executeCommand('touch /tmp/a; mv -n -T /tmp/a /tmp/b; mkfifo -m 600 /tmp/ff; ls -1 /tmp')).toBe('b\nff');
  });
  it('stat --format and -L', async () => {
    expect(await pc().executeCommand('stat -L --format=%F /etc/hostname')).toBe('regular file');
  });
});

describe('mv evaluates the options it accepts', () => {
  it('moves several sources into a directory (-t and last operand)', async () => {
    const machine = pc();
    expect(await machine.executeCommand('mkdir /tmp/d; touch /tmp/a /tmp/b /tmp/c; mv /tmp/a /tmp/b /tmp/d; mv -t /tmp/d /tmp/c; ls -1 /tmp/d')).toBe('a\nb\nc');
  });
  it('-n keeps an existing destination', async () => {
    const machine = pc();
    expect(await machine.executeCommand('echo one > /tmp/a; echo two > /tmp/b; mv -n /tmp/a /tmp/b; cat /tmp/b; ls -1 /tmp')).toBe('two\na\nb');
  });
  it('several sources into a plain file are refused', async () => {
    const machine = pc();
    expect(await machine.executeCommand('touch /tmp/a /tmp/b /tmp/c; mv /tmp/a /tmp/b /tmp/c'))
      .toBe("mv: target '/tmp/c' is not a directory\nTry 'mv --help' for more information.");
  });
  it('-v names every move and a failure does not stop the others', async () => {
    const machine = pc();
    expect(await machine.executeCommand('mkdir /tmp/d; touch /tmp/a; mv -v /tmp/a /tmp/none /tmp/d'))
      .toBe("renamed '/tmp/a' -> '/tmp/d/a'\nmv: cannot stat '/tmp/none': No such file or directory");
  });
  it('a missing destination is named', async () => {
    expect(await pc().executeCommand('mv /tmp/a'))
      .toBe("mv: missing destination file operand after '/tmp/a'\nTry 'mv --help' for more information.");
  });
});
