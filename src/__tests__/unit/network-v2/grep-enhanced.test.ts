/**
 * grep(1) — enhanced behaviour spec.
 *
 * Covers matching modes (§A: -i -v -w -x -F -E/BRE -o -c -n -m -e -f),
 * file/recursive handling (§B: prefixes, -h/-H, -l/-L, -r, --include, -s),
 * and exit-code semantics + egrep/fgrep aliases (§C), driven through the
 * real command executor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => { exec = new LinuxCommandExecutor(false); });

function write(path: string, content: string): void {
  exec.vfs.writeFile(path, content, 0, 0, 0o022);
}
async function run(cmd: string): Promise<string> {
  return await exec.execute(cmd);
}

describe('grep — matching modes (§A)', () => {
  it('A1 prints lines containing the pattern', async () => {
    write('/f', 'apple\nbanana\ncherry\n');
    expect(await run('grep an /f')).toBe('banana');
  });
  it('A2 -i is case-insensitive', async () => {
    write('/f', 'Apple\nAPPLE\norange\n');
    expect(await run('grep -i apple /f')).toBe('Apple\nAPPLE');
  });
  it('A3 -v inverts the match', async () => {
    write('/f', 'keep\ndrop\nkeep\n');
    expect(await run('grep -v drop /f')).toBe('keep\nkeep');
  });
  it('A4 -w matches whole words only', async () => {
    write('/f', 'cat\ncategory\nthe cat sat\n');
    expect(await run('grep -w cat /f')).toBe('cat\nthe cat sat');
  });
  it('A5 -x matches whole lines only', async () => {
    write('/f', 'cat\ncatt\ncat \n');
    expect(await run('grep -x cat /f')).toBe('cat');
  });
  it('A6 -F treats the pattern as a literal string', async () => {
    write('/f', 'a.b\naxb\n');
    expect(await run("grep -F a.b /f")).toBe('a.b');
  });
  it('A7 -E enables extended regex operators', async () => {
    write('/f', 'abbbc\nac\nabc\n');
    expect(await run("grep -E ab+c /f")).toBe('abbbc\nabc');
  });
  it('A8 the default BRE leaves + literal', async () => {
    write('/f', 'a+b\naaa\n');
    expect(await run("grep a+ /f")).toBe('a+b');
  });
  it('A9 -o prints only the matching substrings', async () => {
    write('/f', 'aXbaY\n');
    expect(await run("grep -o a. /f")).toBe('aX\naY');
  });
  it('A10 -c counts matching lines', async () => {
    write('/f', 'x\ny\nx\nx\n');
    expect(await run('grep -c x /f')).toBe('3');
  });
  it('A11 -n prefixes line numbers', async () => {
    write('/f', 'a\nb\na\n');
    expect(await run('grep -n a /f')).toBe('1:a\n3:a');
  });
  it('A12 -m stops after N matches', async () => {
    write('/f', 'a\na\na\na\n');
    expect(await run('grep -m 2 a /f')).toBe('a\na');
  });
  it('A13 multiple -e patterns OR together', async () => {
    write('/f', 'apple\nkiwi\nplum\n');
    expect(await run('grep -e apple -e plum /f')).toBe('apple\nplum');
  });
  it('A14 -f reads patterns from a file', async () => {
    write('/pats', 'apple\nplum\n');
    write('/f', 'apple\nkiwi\nplum\n');
    expect(await run('grep -f /pats /f')).toBe('apple\nplum');
  });
  it('A15 POSIX class [[:digit:]] works', async () => {
    write('/f', 'abc\na1c\n');
    expect(await run("grep [[:digit:]] /f")).toBe('a1c');
  });
});

describe('grep — files & recursion (§B)', () => {
  it('B1 prefixes the filename when searching multiple files', async () => {
    write('/a', 'hit\n'); write('/b', 'hit\n');
    expect(await run('grep hit /a /b')).toBe('/a:hit\n/b:hit');
  });
  it('B2 -h suppresses the filename prefix', async () => {
    write('/a', 'hit\n'); write('/b', 'hit\n');
    expect(await run('grep -h hit /a /b')).toBe('hit\nhit');
  });
  it('B3 -H forces the filename prefix on a single file', async () => {
    write('/a', 'hit\n');
    expect(await run('grep -H hit /a')).toBe('/a:hit');
  });
  it('B4 -l lists only files that match', async () => {
    write('/a', 'yes\n'); write('/b', 'no\n');
    expect(await run('grep -l yes /a /b')).toBe('/a');
  });
  it('B5 -L lists only files that do not match', async () => {
    write('/a', 'yes\n'); write('/b', 'no\n');
    expect(await run('grep -L yes /a /b')).toBe('/b');
  });
  it('B6 -r searches a directory tree', async () => {
    exec.vfs.mkdirp('/d/sub', 0o755, 0, 0);
    write('/d/one.txt', 'needle\n');
    write('/d/sub/two.txt', 'needle\n');
    write('/d/sub/three.txt', 'hay\n');
    const out = (await run('grep -r needle /d')).split('\n').sort();
    expect(out).toEqual(['/d/one.txt:needle', '/d/sub/two.txt:needle']);
  });
  it('B7 --include limits -r to matching filenames', async () => {
    exec.vfs.mkdirp('/d', 0o755, 0, 0);
    write('/d/keep.log', 'needle\n');
    write('/d/skip.txt', 'needle\n');
    expect(await run('grep -r --include=*.log needle /d')).toBe('/d/keep.log:needle');
  });
  it('B8 -s suppresses missing-file errors', async () => {
    expect(await run('grep -s x /does/not/exist')).toBe('');
  });
  it('B9 a missing file without -s reports an error', async () => {
    expect(await run('grep x /nope')).toContain('No such file or directory');
  });
});

describe('grep — exit codes & aliases (§C)', () => {
  it('C1 exits 0 when something matches', async () => {
    expect(await run("printf 'a\\nb\\n' | grep -q a && echo HIT")).toBe('HIT');
  });
  it('C2 exits 1 when nothing matches', async () => {
    expect(await run("printf 'a\\nb\\n' | grep -q zzz || echo MISS")).toBe('MISS');
  });
  it('C3 -q produces no output but still gates a chain', async () => {
    write('/f', 'token\n');
    expect(await run('grep -q token /f && echo FOUND')).toBe('FOUND');
  });
  it('C4 egrep behaves like grep -E', async () => {
    write('/f', 'abbbc\nac\n');
    expect(await run('egrep ab+c /f')).toBe('abbbc');
  });
  it('C5 fgrep behaves like grep -F', async () => {
    write('/f', 'a.b\naxb\n');
    expect(await run('fgrep a.b /f')).toBe('a.b');
  });
  it('C6 a pipeline filters its stdin', async () => {
    expect(await run("printf 'one\\ntwo\\nthree\\n' | grep o")).toBe('one\ntwo');
  });
});
