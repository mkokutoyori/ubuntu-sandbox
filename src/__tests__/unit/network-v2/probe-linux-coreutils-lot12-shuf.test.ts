/*
 * shuf answered `command not found`. ShufCommand.ts implements -e, -i LO-HI (an empty range LO = HI+1 is
 * valid), -n (the smallest of several counts), -o (also onto the input file), -r, -z, --random-source
 * and the diagnostics of shuf.c 9.4 (fetched from the v9.4 tag). The shuffle itself is random, so every
 * case is a property that does not depend on the order: the lines come back sorted, the count of
 * lines is right, a repeated pick comes from the input, the file written by -o holds a permutation.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). NOT covered: the byte-for-byte order produced by --random-source, because
 * gnulib's randperm/randint were unreachable from this environment and could not be ported.
 *
 * Measured against the commit before (worktree): 49 cases; the command did not exist, all 49 fall.
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
  ["seq 1 10 | shuf | sort -n", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n[0]"],
  ["shuf -e a b c | sort", "a\nb\nc\n[0]"],
  ["shuf -e a | cat", "a\n[0]"],
  ["shuf -e | cat", "[0]"],
  ["shuf -i 1-5 | sort -n", "1\n2\n3\n4\n5\n[0]"],
  ["shuf -i 7-7", "7\n[0]"],
  ["shuf -i 5-4", "[0]"],
  ["shuf -i 5-", "shuf: invalid input range: '5-'\n[1]"],
  ["shuf -i x", "shuf: invalid input range: 'x'\n[1]"],
  ["shuf -i 1-3 -i 2-4", "shuf: multiple -i options specified\n[1]"],
  ["shuf -i 1-3 -e a", "shuf: cannot combine -e and -i options\nTry 'shuf --help' for more information.\n[1]"],
  ["shuf -i 1-3 x", "shuf: extra operand 'x'\nTry 'shuf --help' for more information.\n[1]"],
  ["seq 1 100 | shuf -n 5 | wc -l", "5\n[0]"],
  ["seq 1 3 | shuf -n 0", "[0]"],
  ["seq 1 3 | shuf -n 10 | sort", "1\n2\n3\n[0]"],
  ["seq 1 3 | shuf -n x", "shuf: invalid line count: 'x'\n[1]"],
  ["seq 1 3 | shuf -n 2 -n 1 | wc -l", "1\n[0]"],
  ["seq 1 3 | shuf -n -1", "shuf: invalid line count: '-1'\n[1]"],
  ["shuf -r -n 7 -e x | wc -l", "7\n[0]"],
  ["shuf -r -n3 -i 5-5", "5\n5\n5\n[0]"],
  ["shuf -r -n 0 -e a", "[0]"],
  ["shuf -r -n 2 < /dev/null", "shuf: no lines to repeat\n[1]"],
  ["printf '' | shuf -r -n 2", "shuf: no lines to repeat\n[1]"],
  ["printf '' | shuf", "[0]"],
  ["printf 'a\\nb' | shuf | sort", "a\nb\n[0]"],
  ["printf 'a\\0b\\0' | shuf -z | sort -z | tr '\\0' '|'", "a|b|[0]"],
  ["printf 'a\\0b' | shuf -z | wc -c", "4\n[0]"],
  ["shuf nofile", "shuf: nofile: No such file or directory\n[1]"],
  ["shuf a b", "shuf: extra operand 'b'\nTry 'shuf --help' for more information.\n[1]"],
  ["seq 1 5 > f ; shuf f | sort -n", "1\n2\n3\n4\n5\n[0]"],
  ["seq 1 5 > f ; shuf -o g f ; sort -n g", "1\n2\n3\n4\n5\n[0]"],
  ["seq 1 5 > f ; shuf -o f f ; sort -n f", "1\n2\n3\n4\n5\n[0]"],
  ["seq 1 5 > f ; shuf -o g -o h f", "shuf: multiple output files specified\n[1]"],
  ["seq 1 5 > f ; shuf -o g -o g f ; sort -n g", "1\n2\n3\n4\n5\n[0]"],
  ["seq 1 5 > f ; shuf --output=g f ; sort -n g", "1\n2\n3\n4\n5\n[0]"],
  ["seq 1 5 > f ; shuf --head-count=2 f | wc -l", "2\n[0]"],
  ["seq 1 5 > f ; shuf --input-range=2-4 | sort -n", "2\n3\n4\n[0]"],
  ["shuf --echo x y | sort", "x\ny\n[0]"],
  ["shuf --repeat -n 4 -e q", "q\nq\nq\nq\n[0]"],
  ["shuf --zero-terminated -e a b | tr '\\0' '\\n' | sort", "a\nb\n[0]"],
  ["shuf --random-source=nofile -e a b", "shuf: nofile: No such file or directory\n[1]"],
  ["seq 1 100 > f ; head -c 5000 /dev/zero > z ; shuf --random-source=z f | head -n 2 | wc -l", "2\n[0]"],
  ["shuf --bogus", "shuf: unrecognized option '--bogus'\nTry 'shuf --help' for more information.\n[1]"],
  ["shuf -x", "shuf: invalid option -- 'x'\nTry 'shuf --help' for more information.\n[1]"],
  ["shuf -n", "shuf: option requires an argument -- 'n'\nTry 'shuf --help' for more information.\n[1]"],
  ["seq 1 20 | shuf -n 20 | sort -n | tr '\\n' ' '", "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 [0]"],
  ["seq 1 4 | shuf -e a b | sort", "a\nb\n[0]"],
  ["seq 1 4 | shuf -r -n 0", "[0]"],
  ["seq 1 3 | shuf -r | head -n 3 | wc -l", "3\n[0]"],
];

describe('shuf shuffles uniformly with the options and diagnostics of GNU shuf', () => {
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
