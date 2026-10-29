/*
 * grep accepted options it did not evaluate: `-o` printed empty matches,
 * `-f /dev/null` matched everything, `-s` on a missing file exited 1, a file
 * holding a NUL byte was printed instead of "binary file matches", `-a`/`-I`/
 * `--binary-files` were ignored, a directory operand answered "No such file",
 * context lines used ':' like matched lines and never printed the `--` group
 * separator (`--group-separator`, `--no-group-separator`), `-z` and `-T` did
 * nothing, `-d skip` dropped the file-name prefix, and `--color` lacked the
 * `\e[K` of GNU grep and the colours of file names, line numbers, byte offsets
 * and separators.
 *
 * Every expected string was produced by the real GNU grep 3.11 of the dev
 * container on the same tree (a.txt six lines, b.log, sub/c.txt, bin.dat with a
 * NUL byte, n.txt twelve lines). Ubuntu 22.04 ships 3.7; the options exercised
 * here behave alike in both. Recursive cases compare their lines SORTED
 * (readdir order differs). Not covered: -P specifics, locale-dependent
 * classes, devices (-D).
 *
 * Measured against the commit before the rewrite (worktree): 83 cases, 34 fall;
 * the 49 that pass either way are the plain searches (-n -c -i -v -w -x -l
 * -L -H -h -m -E -F -e -A -B -C and the missing-file messages).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(
    "mkdir -p /tmp/gfx/sub; cd /tmp/gfx; printf 'alpha one\\nBeta two\\nalpha THREE\\n\\ngamma 4 five\\nalpha-six 66\\n' > a.txt; "
    + "printf 'delta alpha\\nepsilon\\nalphabet soup\\n' > b.log; printf 'nested alpha\\n' > sub/c.txt; "
    + "printf 'bin\\0ary alpha\\n' > bin.dat; seq 1 12 | sed 's/^/line /' > n.txt",
  );
  return machine;
}

const recursive = (args: string): boolean => /(^| )-[a-zA-Z]*r|--include|--exclude-dir/.test(args);
const sortLines = (text: string): string => text.split('\n').sort().join('\n');

describe('grep evaluates what it accepts, like GNU grep 3.11', () => {
  it.each<[string, string]>([
    ["alpha a.txt", "alpha one\nalpha THREE\nalpha-six 66"],
    ["-n alpha a.txt", "1:alpha one\n3:alpha THREE\n6:alpha-six 66"],
    ["-c alpha a.txt", "3"],
    ["-i beta a.txt", "Beta two"],
    ["-v alpha a.txt", "Beta two\n\ngamma 4 five"],
    ["-w alpha a.txt", "alpha one\nalpha THREE\nalpha-six 66"],
    ["-x 'alpha one' a.txt", "alpha one"],
    ["-o '[0-9]*' a.txt", "4\n66"],
    ["-o -b alpha a.txt", "0:alpha\n19:alpha\n45:alpha"],
    ["-l alpha a.txt b.log", "a.txt\nb.log"],
    ["-L alpha a.txt b.log", ""],
    ["-H alpha a.txt", "a.txt:alpha one\na.txt:alpha THREE\na.txt:alpha-six 66"],
    ["-h alpha a.txt b.log", "alpha one\nalpha THREE\nalpha-six 66\ndelta alpha\nalphabet soup"],
    ["-A1 Beta a.txt", "Beta two\nalpha THREE"],
    ["-B1 gamma a.txt", "\ngamma 4 five"],
    ["-C1 gamma a.txt", "\ngamma 4 five\nalpha-six 66"],
    ["-m1 alpha a.txt", "alpha one"],
    ["-E 'alpha|gamma' a.txt", "alpha one\nalpha THREE\ngamma 4 five\nalpha-six 66"],
    ["-F alpha-six a.txt", "alpha-six 66"],
    ["-e alpha -e gamma a.txt", "alpha one\nalpha THREE\ngamma 4 five\nalpha-six 66"],
    ["-f /dev/null a.txt", ""],
    ["-v -f /dev/null a.txt", "alpha one\nBeta two\nalpha THREE\n\ngamma 4 five\nalpha-six 66"],
    ["-s alpha nothere a.txt", "a.txt:alpha one\na.txt:alpha THREE\na.txt:alpha-six 66"],
    ["alpha nothere a.txt", "grep: nothere: No such file or directory\na.txt:alpha one\na.txt:alpha THREE\na.txt:alpha-six 66"],
    ["-q alpha a.txt; echo $?", "0"],
    ["-s alpha nothere; echo $?", "2"],
    ["-Z -l alpha a.txt b.log", "a.txt\u0000b.log\u0000"],
    ["--color=always alpha a.txt", "\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K one\n\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K THREE\n\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K-six 66"],
    ["-n --color=always -H alpha a.txt", "\u001b[35m\u001b[Ka.txt\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[32m\u001b[K1\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K one\n\u001b[35m\u001b[Ka.txt\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[32m\u001b[K3\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K THREE\n\u001b[35m\u001b[Ka.txt\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[32m\u001b[K6\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K-six 66"],
    ["-n --color=always -A1 Beta a.txt", "\u001b[32m\u001b[K2\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[KBeta\u001b[m\u001b[K two\n\u001b[32m\u001b[K3\u001b[m\u001b[K\u001b[36m\u001b[K-\u001b[m\u001b[Kalpha THREE"],
    ["--color=always -c alpha a.txt b.log", "\u001b[35m\u001b[Ka.txt\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K3\n\u001b[35m\u001b[Kb.log\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K2"],
    ["--color=always -l alpha a.txt b.log", "\u001b[35m\u001b[Ka.txt\u001b[m\u001b[K\n\u001b[35m\u001b[Kb.log\u001b[m\u001b[K"],
    ["--color=always -o alpha a.txt", "\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K\n\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K\n\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K"],
    ["--color=always -b alpha a.txt", "\u001b[32m\u001b[K0\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K one\n\u001b[32m\u001b[K19\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K THREE\n\u001b[32m\u001b[K45\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K-six 66"],
    ["-C1 --color=always gamma a.txt", "\n\u001b[01;31m\u001b[Kgamma\u001b[m\u001b[K 4 five\nalpha-six 66"],
    ["--color=always -nA0 alpha a.txt", "\u001b[32m\u001b[K1\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K one\n\u001b[36m\u001b[K--\u001b[m\u001b[K\n\u001b[32m\u001b[K3\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K THREE\n\u001b[36m\u001b[K--\u001b[m\u001b[K\n\u001b[32m\u001b[K6\u001b[m\u001b[K\u001b[36m\u001b[K:\u001b[m\u001b[K\u001b[01;31m\u001b[Kalpha\u001b[m\u001b[K-six 66"],
    ["--color=always -v alpha a.txt", "Beta two\n\ngamma 4 five"],
    ["-T alpha a.txt", "alpha one\nalpha THREE\nalpha-six 66"],
    ["-nT alpha a.txt", " 1:\talpha one\n 3:\talpha THREE\n 6:\talpha-six 66"],
    ["-nbT line n.txt", " 1: 0:\tline 1\n 2: 7:\tline 2\n 3:14:\tline 3\n 4:21:\tline 4\n 5:28:\tline 5\n 6:35:\tline 6\n 7:42:\tline 7\n 8:49:\tline 8\n 9:56:\tline 9\n10:63:\tline 10\n11:71:\tline 11\n12:79:\tline 12"],
    ["-HnT alpha a.txt", "a.txt: 1:\talpha one\na.txt: 3:\talpha THREE\na.txt: 6:\talpha-six 66"],
    ["-on alpha a.txt", "1:alpha\n3:alpha\n6:alpha"],
    ["-ob alpha a.txt", "0:alpha\n19:alpha\n45:alpha"],
    ["-E -o 'al[a-z]+' a.txt", "alpha\nalpha\nalpha"],
    ["-w -o alpha a.txt", "alpha\nalpha\nalpha"],
    ["-y ALPHA a.txt", "alpha one\nalpha THREE\nalpha-six 66"],
    ["-d skip alpha sub a.txt", "a.txt:alpha one\na.txt:alpha THREE\na.txt:alpha-six 66"],
    ["alpha sub", "grep: sub: Is a directory"],
    ["-d read alpha sub", "grep: sub: Is a directory"],
    ["-d recurse alpha sub", "sub/c.txt:nested alpha"],
    ["-nb alpha a.txt", "1:0:alpha one\n3:19:alpha THREE\n6:45:alpha-six 66"],
    ["--max-count=2 -n alpha a.txt", "1:alpha one\n3:alpha THREE"],
    ["-A1 -B1 -n gamma a.txt", "4-\n5:gamma 4 five\n6-alpha-six 66"],
    ["--no-group-separator -A1 alpha a.txt", "alpha one\nBeta two\nalpha THREE\n\nalpha-six 66"],
    ["--group-separator=XX -A0 alpha a.txt", "alpha one\nXX\nalpha THREE\nXX\nalpha-six 66"],
    ["-nA1 alpha a.txt", "1:alpha one\n2-Beta two\n3:alpha THREE\n4-\n--\n6:alpha-six 66"],
    ["'' a.txt", "alpha one\nBeta two\nalpha THREE\n\ngamma 4 five\nalpha-six 66"],
    ["-v '' a.txt", ""],
    ["-Ec '^a' a.txt", "3"],
    ["-m1 -A1 alpha a.txt", "alpha one\nBeta two"],
    ["-m1 -c alpha a.txt", "1"],
    ["-A1 alpha a.txt b.log", "a.txt:alpha one\na.txt-Beta two\na.txt:alpha THREE\na.txt-\n--\na.txt:alpha-six 66\n--\nb.log:delta alpha\nb.log-epsilon\nb.log:alphabet soup"],
    ["-nH -C1 epsilon b.log a.txt", "b.log-1-delta alpha\nb.log:2:epsilon\nb.log-3-alphabet soup"],
    ["-c line a.txt n.txt", "a.txt:0\nn.txt:12"],
    ["-Z -c line a.txt n.txt", "a.txt\u00000\nn.txt\u000012"],
    ["-zc alpha a.txt", "1"],
    ["-a alpha bin.dat", "bin\u0000ary alpha"],
    ["alpha bin.dat", "grep: bin.dat: binary file matches"],
    ["-c alpha bin.dat", "1"],
    ["-l alpha bin.dat", "bin.dat"],
    ["-o alpha bin.dat", "grep: bin.dat: binary file matches"],
    ["-n alpha bin.dat", "grep: bin.dat: binary file matches"],
    ["-q alpha bin.dat; echo $?", "0"],
    ["-v zzz bin.dat", "grep: bin.dat: binary file matches"],
    ["-I alpha bin.dat a.txt", "a.txt:alpha one\na.txt:alpha THREE\na.txt:alpha-six 66"],
    ["--binary-files=without-match alpha bin.dat", ""],
    ["--binary-files=text alpha bin.dat", "bin\u0000ary alpha"],
    ["--binary-files=bad alpha bin.dat", "grep: unknown binary-files type"],
    ["-r alpha sub", "sub/c.txt:nested alpha"],
    ["-r alpha a.txt", "alpha one\nalpha THREE\nalpha-six 66"],
    ["-rl alpha sub", "sub/c.txt"],
    ["--include='*.log' -r alpha .", "./b.log:delta alpha\n./b.log:alphabet soup"],
    ["--exclude-dir=sub -rl alpha .", "./b.log\n./bin.dat\n./a.txt"],
  ])('grep %s', async (args, expected) => {
    const machine = await lab();
    const out = await machine.executeCommand(`cd /tmp/gfx; grep ${args}`);
    expect(recursive(args) ? sortLines(out) : out).toBe(recursive(args) ? sortLines(expected) : expected);
  });
});
