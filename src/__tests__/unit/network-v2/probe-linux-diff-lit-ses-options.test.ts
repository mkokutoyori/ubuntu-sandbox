/*
 * diff knew one output format and no option: `diff -u`, `-c`, `-q`, `-s`, `-i`,
 * `-w`, `-b`, `-B`, `-r`, `-N`, `--label` and directory operands were all
 * ignored (a directory was read as a missing file), and `diff --zorglub` printed
 * nothing. The edit script is built once (LCS on a comparison key shaped by
 * -i/-w/-b/-Z) and rendered as normal, unified (-u/-U N) or context (-c/-C N,
 * -NUM) with GNU's hunk grouping; -q and -s print the one-line verdicts; two
 * directories list Only in / Common subdirectories, and -r recurses with the
 * `diff <options> a b` line before each file; -N reads a missing side as empty;
 * the exit status is 0/1/2. Labels replace the timestamp headers, which come from
 * the file mtime in the machine zone. -y, -e, -f, -n, -D, -p, -T, --color and the
 * other output styles are accepted without effect (TODO.md). Layouts are those of
 * GNU diffutils from memory, not from a fetched page.
 *
 * Measured before the change: 18 cases, 16 fall; 2 pass either way: the witness (normal
 * format) and `-i`, whose result happens to equal the normal format on that pair.
 * The shell used to send the stdout of a command exiting 1 to the terminal when only
 * `>` was redirected (a failing command's output without stderr is read as a
 * diagnostic); diff now declares an empty stderr for status 1, so `diff a b > f`
 * redirects the diff.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(...lines: string[]): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(
    'mkdir -p /tmp/d/d1/sub /tmp/d/d2/sub; cd /tmp/d; '
    + 'printf "one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\n" > a; printf "one\\nTWO\\nthree\\nfour\\nsix\\nseven\\neight\\n" > b; '
    + 'printf "x\\n" > same1; printf "x\\n" > same2; printf "Hello  World\\n" > w1; printf "hello world\\n" > w2; '
    + 'printf "one\\n\\ntwo\\n" > blank1; printf "one\\ntwo\\n" > blank2; '
    + 'printf "one\\n" > d1/y; printf "uno\\n" > d2/y; printf "k\\n" > d1/x; printf "k\\n" > d2/x; printf "o\\n" > d1/only1; '
    + 'printf "s1\\n" > d1/sub/s; printf "s2\\n" > d2/sub/s',
  );
  let last = '';
  for (const line of lines) last = await machine.executeCommand(line);
  return last;
}

describe('witness', () => {
  it('the normal format', async () => {
    expect(await run('cd /tmp/d; diff a b')).toBe('2c2\n< two\n---\n> TWO\n5d4\n< five\n7a7\n> eight');
  });
});

describe('output formats', () => {
  it('unified with labels', async () => {
    expect(await run('cd /tmp/d; diff -u --label A --label B a b')).toBe([
      '--- A', '+++ B', '@@ -1,7 +1,7 @@', ' one', '-two', '+TWO', ' three', ' four', '-five', ' six', ' seven', '+eight',
    ].join('\n'));
  });
  it('unified with a narrow context splits the hunks', async () => {
    expect(await run('cd /tmp/d; diff -U0 --label A --label B a b')).toBe([
      '--- A', '+++ B', '@@ -2 +2 @@', '-two', '+TWO', '@@ -5 +4,0 @@', '-five', '@@ -7,0 +7 @@', '+eight',
    ].join('\n'));
  });
  it('context format marks changes per region', async () => {
    expect(await run('cd /tmp/d; diff -c --label A --label B a b')).toBe([
      '*** A', '--- B', '***************', '*** 1,7 ****', '  one', '! two', '  three', '  four', '- five', '  six', '  seven',
      '--- 1,7 ----', '  one', '! TWO', '  three', '  four', '  six', '  seven', '+ eight',
    ].join('\n'));
  });
  it('the timestamp header carries the file mtime', async () => {
    expect((await run('cd /tmp/d; diff -u a b')).split('\n')[0]).toMatch(/^--- a\t\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} [+-]\d{4}$/);
  });
});

describe('verdicts and exit status', () => {
  it('-q', async () => { expect(await run('cd /tmp/d; diff -q a b')).toBe('Files a and b differ'); });
  it('-s on identical files', async () => { expect(await run('cd /tmp/d; diff -s same1 same2')).toBe('Files same1 and same2 are identical'); });
  it('exit status 1 on a difference, 0 on none, 2 on trouble', async () => {
    expect(await run('cd /tmp/d; diff a b > /dev/null; echo $?')).toBe('1');
    expect(await run('cd /tmp/d; diff same1 same2; echo $?')).toBe('0');
    expect(await run('cd /tmp/d; diff a nope; echo $?')).toBe('diff: nope: No such file or directory\n2');
  });
  it('an unknown option is refused', async () => {
    expect(await run('diff --zorglub a b')).toBe("diff: unrecognized option '--zorglub'\ndiff: Try 'diff --help' for more information.");
  });
});

describe('comparison switches', () => {
  it('-i ignores case', async () => { expect(await run('cd /tmp/d; diff -i w1 w2')).toBe('1c1\n< Hello  World\n---\n> hello world'); });
  it('-w ignores all white space and -i ignores case together', async () => { expect(await run('cd /tmp/d; diff -wi -s w1 w2')).toBe('Files w1 and w2 are identical'); });
  it('-b ignores changes in the amount of white space', async () => { expect(await run('cd /tmp/d; diff -bi -s w1 w2')).toBe('Files w1 and w2 are identical'); });
  it('-B ignores blank lines', async () => { expect(await run('cd /tmp/d; diff -B -s blank1 blank2')).toBe('Files blank1 and blank2 are identical'); });
});

describe('directories', () => {
  it('lists what exists on one side only and compares the common files', async () => {
    expect(await run('cd /tmp/d; diff d1 d2')).toBe('Only in d1: only1\nCommon subdirectories: d1/sub and d2/sub\ndiff d1/y d2/y\n1c1\n< one\n---\n> uno');
  });
  it('-r recurses and announces each file', async () => {
    expect(await run('cd /tmp/d; diff -r d1 d2')).toBe('Only in d1: only1\ndiff -r d1/sub/s d2/sub/s\n1c1\n< s1\n---\n> s2\ndiff -r d1/y d2/y\n1c1\n< one\n---\n> uno');
  });
  it('-rq prints one line per differing file', async () => {
    expect(await run('cd /tmp/d; diff -rq d1 d2')).toBe('Only in d1: only1\nFiles d1/sub/s and d2/sub/s differ\nFiles d1/y and d2/y differ');
  });
  it('-N reads a missing file as empty', async () => {
    expect(await run('cd /tmp/d; diff -rN d1 d2 | head -3')).toBe('diff -rN d1/only1 d2/only1\n1d0\n< o');
  });
  it('a file against a directory looks inside the directory', async () => {
    expect(await run('cd /tmp/d; diff d1/y d2')).toBe('1c1\n< one\n---\n> uno');
  });
});
