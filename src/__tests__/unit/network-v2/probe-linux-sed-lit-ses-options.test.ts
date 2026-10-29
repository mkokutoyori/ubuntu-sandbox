/*
 * sed took the first word it did not recognise as its script: `sed --zorglub
 * s/a/b/ f` answered "unknown command: `-'", `sed -i.bak` edited without keeping
 * the backup, `sed --help` and `--version` were parsed as scripts, and an
 * unreadable input file was read as empty. Options are read through the shared
 * getopt reader (SedOptions.ts); an unknown option prints GNU's diagnostic then
 * the usage; -i[SUFFIX] and --in-place[=SUFFIX] write the backup (a '*' in the
 * suffix stands for the base name); a missing input is reported with exit 2.
 * Usage and version texts are those of sed 4.8 from memory, not a fetched page;
 * -z, -l, --posix, --debug, --sandbox and --follow-symlinks are accepted and have
 * no effect yet (TODO.md).
 *
 * Measured before the change: 12 cases, 10 fall; the 2 witnesses (-n/p, -E)
 * pass either way (the grouped -ne also fell: `e` was not read from a cluster).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(...lines: string[]): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/e; printf "alpha\\nbeta\\n" > /tmp/e/f');
  let last = '';
  for (const line of lines) last = await machine.executeCommand(line);
  return last;
}

describe('witnesses', () => {
  it('-n with p', async () => { expect(await run('sed -n 1p /tmp/e/f')).toBe('alpha'); });
  it('-e and grouped -ne', async () => {
    expect(await run('sed -e s/a/A/ /tmp/e/f')).toBe('Alpha\nbetA');
    expect(await run('sed -ne 2p /tmp/e/f')).toBe('beta');
  });
  it('-E', async () => { expect(await run('sed -E "s/(a)(l)/\\2\\1/" /tmp/e/f')).toBe('lapha\nbeta'); });
});

describe('options', () => {
  it('an unknown long option is refused with the usage', async () => {
    const out = await run('sed --zorglub s/a/b/ /tmp/e/f');
    expect(out.split('\n')[0]).toBe("sed: unrecognized option '--zorglub'");
    expect(out).toContain('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...');
  });
  it('an unknown short option is refused with the usage', async () => {
    const out = await run('sed -Q s/a/b/ /tmp/e/f');
    expect(out.split('\n')[0]).toBe("sed: invalid option -- 'Q'");
    expect(out).toContain('Usage: sed');
  });
  it('--help prints the usage', async () => { expect(await run('sed --help')).toContain('-i[SUFFIX], --in-place[=SUFFIX]'); });
  it('--version names GNU sed', async () => { expect((await run('sed --version')).split('\n')[0]).toBe('sed (GNU sed) 4.8'); });
  it('no script at all prints the usage', async () => { expect(await run('sed')).toContain('Usage: sed'); });
  it('-i.bak keeps the original', async () => {
    expect(await run('sed -i.bak s/alpha/ALPHA/ /tmp/e/f', 'cat /tmp/e/f /tmp/e/f.bak')).toBe('ALPHA\nbeta\nalpha\nbeta');
  });
  it('--in-place=bak_* puts the backup under a derived name', async () => {
    expect(await run('sed --in-place=bak_* s/beta/B/ /tmp/e/f', 'cat /tmp/e/bak_f')).toBe('alpha\nbeta');
  });
  it('a missing input is reported and the others still run', async () => {
    expect(await run('sed -n 1p /tmp/e/nope /tmp/e/f')).toBe("sed: can't read /tmp/e/nope: No such file or directory\nalpha");
  });
  it('a missing script file is reported', async () => {
    expect(await run('sed -f /tmp/e/none /tmp/e/f')).toBe("sed: couldn't open file /tmp/e/none: No such file or directory");
  });
});
