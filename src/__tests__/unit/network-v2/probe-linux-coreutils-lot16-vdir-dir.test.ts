/*
 * vdir and dir answered `command not found`. They are ls -l -b and ls -C -b: the shim runs ls with those
 * options, renames the program in its diagnostics and in the `Try` line, answers --help and --version
 * from the docs table and exits 2 on a refused option. ls -b (--escape) now backslash-escapes a space
 * and a double quote as the real ls does (it only escaped newline, tab and backslash).
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). Lines prefixed ROOT: were run as root on both sides.
 *
 * Measured against the commit before (worktree): 18 cases; all 18 fall (the commands did not exist).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "total 36\n-rw-r--r-- 1 root root    0 T a\n-rw-r--r-- 1 root root    3 T a.txt\n-rw-r--r-- 1 root root    0 T b\n-rw-r--r-- 1 root root 3000 T big\n-rw-r--r-- 1 root root    6 T c\ndrwxr-xr-x 2 root root 4096 T d\nlrwxrwxrwx 1 root root    7 T dang -> nowhere\nlrwxrwxrwx 1 root root    3 T dlnk -> sub\n-rw-r--r-- 1 root root   10 T list0\nlrwxrwxrwx 1 root root    5 T lnk -> a.txt\nlrwxrwxrwx 1 root root    4 T lnk2 -> lnk2\n-rw-r--r-- 1 root root   21 T nums\ndrwxr-xr-x 4 root root 4096 T sub\n-rw-r--r-- 1 root root   58 T words\n-rw-r--r-- 1 root root    6 T z\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir c | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "-rw-r--r-- 1 root root 6 T c\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir nofile", "vdir: cannot access 'nofile': No such file or directory\n[2]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir -a nofile", "vdir: cannot access 'nofile': No such file or directory\n[2]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir d", "total 0\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir -d d | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "drwxr-xr-x 2 root root 4096 T d\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir --bogus", "vdir: unrecognized option '--bogus'\nTry 'vdir --help' for more information.\n[2]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir -h c | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "-rw-r--r-- 1 root root 6 T c\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; vdir -R | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", ".:\ntotal 36\n-rw-r--r-- 1 root root    0 T a\n-rw-r--r-- 1 root root    3 T a.txt\n-rw-r--r-- 1 root root    0 T b\n-rw-r--r-- 1 root root 3000 T big\n-rw-r--r-- 1 root root    6 T c\ndrwxr-xr-x 2 root root 4096 T d\nlrwxrwxrwx 1 root root    7 T dang -> nowhere\nlrwxrwxrwx 1 root root    3 T dlnk -> sub\n-rw-r--r-- 1 root root   10 T list0\nlrwxrwxrwx 1 root root    5 T lnk -> a.txt\nlrwxrwxrwx 1 root root    4 T lnk2 -> lnk2\n-rw-r--r-- 1 root root   21 T nums\ndrwxr-xr-x 4 root root 4096 T sub\n-rw-r--r-- 1 root root   58 T words\n-rw-r--r-- 1 root root    6 T z\n\n./d:\ntotal 0\n\n./sub:\ntotal 12\n-rw------- 1 root root    3 T b.log\ndrwxr-xr-x 2 root root 4096 T deep\ndrwxr-xr-x 2 root root 4096 T empty\n\n./sub/deep:\ntotal 0\n-rw-r--r-- 1 root root 0 T c.txt\n\n./sub/empty:\ntotal 0\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir", "a  a.txt  b  big  c  d\tdang  dlnk  list0  lnk\tlnk2  nums  sub  words\tz\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir -1", "a\na.txt\nb\nbig\nc\nd\ndang\ndlnk\nlist0\nlnk\nlnk2\nnums\nsub\nwords\nz\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir nofile", "dir: cannot access 'nofile': No such file or directory\n[2]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir --bogus", "dir: unrecognized option '--bogus'\nTry 'dir --help' for more information.\n[2]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir a b c", "a  b  c\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir -l c | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "-rw-r--r-- 1 root root 6 T c\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; dir -b", "a  a.txt  b  big  c  d\tdang  dlnk  list0  lnk\tlnk2  nums  sub  words\tz\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; printf 'x\\n' > 'we ird' ; dir", "a      b    c  dang  list0  lnk2  sub\t   words\na.txt  big  d  dlnk  lnk    nums  we\\ ird  z\n[0]"],
  ["ROOT:touch a b ; mkdir -p d ; printf 'hello\\n' > c ; printf 'x\\n' > 'we ird' ; vdir 'we ird' | sed 's/ [A-Z][a-z][a-z] .*:[0-9][0-9] / T /'", "-rw-r--r-- 1 root root 2 T we\\ ird\n[0]"],
];

describe('vdir and dir are ls with fixed options', () => {
  it.each(CASES)('%s', async (line, expected) => {
    const machine = await lab();
    const asRoot = (text: string): Promise<string> => machine.executor.runAsUser('root', () => machine.executeCommand(text));
    const root = line.startsWith('ROOT:');
    const command = line.replace(/^ROOT:/, '');
    await asRoot('cd /tmp/ff; chmod -R u+rwx /tmp/ff; rm -rf /tmp/ff/*');
    if (root) await asRoot(`cd /tmp/ff; ${SETUP}`); else await machine.executeCommand(`cd /tmp/ff; ${SETUP}`);
    const script = `cd /tmp/ff; ${command} 2>&1; echo "[$?]"`;
    const answer = root ? await asRoot(script) : await machine.executeCommand(script);
    expect(normalise(answer)).toBe(expected);
  });
});
