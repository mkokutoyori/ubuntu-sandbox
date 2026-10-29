/*
 * grep skipped any long option it did not know (`grep --zorglub a f` printed the
 * match), ignored the long spellings of -l/-L/-H/-h/-Z/-b/-a, did not know
 * --exclude-dir, --label, --no-ignore-case, --directories, -V and --help, and
 * printed "Usage: grep [OPTION]... PATTERN [FILE]..." (grep 3.7 says PATTERNS)
 * for a missing pattern. Options are read through the shared getopt reader
 * with GREP_OPTIONS (GnuOptionGuard.ts), an unknown one answers GNU's
 * diagnostic, the usage and the Try line with exit status 2, and egrep/fgrep
 * report themselves as grep, the way the Ubuntu wrappers do.
 * -Z, -b, --label, --exclude-dir and --directories are evaluated; -T, -z, -a, -I,
 * -U, --binary-files and --devices are accepted without effect (TODO.md). The
 * help and version texts are those of grep 3.7 from memory.
 *
 * Measured before the change: 23 cases, 18 fall; the 5 witnesses (-n, -c,
 * -r, -E, -A) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(...lines: string[]): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/g/skip /tmp/g/keep; printf "alpha\\nbeta\\n" > /tmp/g/f; printf "alpha skip\\n" > /tmp/g/skip/s; printf "alpha keep\\n" > /tmp/g/keep/k');
  let last = '';
  for (const line of lines) last = await machine.executeCommand(line);
  return last;
}

const USAGE = "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.";

describe('witnesses', () => {
  it('-n', async () => { expect(await run('grep -n beta /tmp/g/f')).toBe('2:beta'); });
  it('-c', async () => { expect(await run('grep -c alpha /tmp/g/f')).toBe('1'); });
  it('-r lists every file', async () => { expect((await run('grep -r alpha /tmp/g')).split('\n')).toHaveLength(3); });
  it('-E', async () => { expect(await run('grep -E "alp|bet" /tmp/g/f')).toBe('alpha\nbeta'); });
  it('-A and -B', async () => { expect(await run('grep -A1 alpha /tmp/g/f')).toBe('alpha\nbeta'); });
});

describe('unknown options and the usage', () => {
  it('an unknown long option', async () => {
    expect(await run('grep --zorglub a /tmp/g/f')).toBe(`grep: unrecognized option '--zorglub'\n${USAGE}`);
  });
  it('an unknown short option', async () => {
    expect(await run('grep -Q a /tmp/g/f')).toBe(`grep: invalid option -- 'Q'\n${USAGE}`);
  });
  it('egrep reports itself as grep', async () => {
    expect(await run('egrep --zorglub a /tmp/g/f')).toBe(`grep: unrecognized option '--zorglub'\n${USAGE}`);
  });
  it('a missing pattern prints PATTERNS', async () => { expect(await run('grep')).toBe(USAGE); });
  it('a missing -e argument', async () => {
    expect(await run('grep -e')).toBe(`grep: option requires an argument -- 'e'\n${USAGE}`);
  });
  it('-V names GNU grep', async () => { expect((await run('grep -V')).split('\n')[0]).toBe('grep (GNU grep) 3.7'); });
  it('--help lists the options', async () => { expect(await run('grep --help')).toContain('-Z, --null                print 0 byte after FILE name'); });
});

describe('options that were skipped', () => {
  it('--files-with-matches', async () => { expect(await run('grep --files-with-matches beta /tmp/g/f')).toBe('/tmp/g/f'); });
  it('--files-without-match', async () => { expect((await run('grep -r --files-without-match beta /tmp/g')).split('\n').sort()).toEqual(['/tmp/g/keep/k', '/tmp/g/skip/s']); });
  it('--with-filename and --no-filename', async () => {
    expect(await run('grep --with-filename beta /tmp/g/f')).toBe('/tmp/g/f:beta');
    expect(await run('grep -r --no-filename keep /tmp/g')).toBe('alpha keep');
  });
  it('-Z puts a NUL after the file name', async () => { expect(await run('grep -Z -H beta /tmp/g/f')).toBe('/tmp/g/f\0beta'); });
  it('-lZ ends each name with a NUL', async () => { expect(await run('grep -lZ beta /tmp/g/f')).toBe('/tmp/g/f\0'); });
  it('-b prints byte offsets', async () => { expect(await run('grep -b beta /tmp/g/f')).toBe('6:beta'); });
  it('-ob prints the offset of the match', async () => { expect(await run('grep -ob eta /tmp/g/f')).toBe('7:eta'); });
  it('--exclude-dir prunes a directory', async () => { expect((await run('grep -r --exclude-dir=skip alpha /tmp/g')).split('\n').sort()).toEqual(['/tmp/g/f:alpha', '/tmp/g/keep/k:alpha keep']); });
  it('--label names standard input', async () => { expect(await run('printf "alpha\\n" | grep -H --label=INPUT alpha')).toBe('INPUT:alpha'); });
  it('--no-ignore-case overrides -i', async () => { expect(await run('grep -i --no-ignore-case ALPHA /tmp/g/f')).toBe(''); });
  it('--directories=skip ignores a directory operand', async () => { expect(await run('grep --directories=skip alpha /tmp/g/skip /tmp/g/f')).toBe('alpha'); });
});
