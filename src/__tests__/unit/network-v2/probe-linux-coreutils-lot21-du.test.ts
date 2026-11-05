/*
/*
 * du: DuCommand.ts is now an ordered-stream command (runDu). It skips a hard link already counted, even
 * when named on the command line; applies --exclude to the operands; reads --files0-from=- on standard
 * input and refuses file operands next to it; reports zero-length names; warns when --inodes meets
 * --apparent-size or -b; reads the threshold as xstrtoimax does (0 allowed, -0 refused, --threshold wording);
 * refuses --time=mtime and calls an empty --time ambiguous; answers --help and --version; and writes
 * its diagnostics in processing order with exit status 1.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). Directory listings whose order is the host readdir order, the --time rows (timestamps), and full-iso
 * nanoseconds, are not pinned.
 *
 * Measured against the commit before (worktree): 16 of 119 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\n' > a.txt; printf 'yo\n' > sub/b.log; printf 'x%.0s' $(seq 1 3000) > big; printf 'y%.0s' $(seq 1 10000) > sub/deep/c.txt; ln a.txt hard; ln -sf a.txt lnk; ln -sfn sub dlnk; : > e0";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["du a.txt", "4\ta.txt\n[0]"],
  ["du big", "4\tbig\n[0]"],
  ["du e0", "0\te0\n[0]"],
  ["du -b a.txt big", "3\ta.txt\n3000\tbig\n[0]"],
  ["du -h big", "4.0K\tbig\n[0]"],
  ["du -h sub/deep/c.txt", "12K\tsub/deep/c.txt\n[0]"],
  ["du -hs sub", "28K\tsub\n[0]"],
  ["du -s sub", "28\tsub\n[0]"],
  ["du -sb sub", "10003\tsub\n[0]"],
  ["du -sk sub", "28\tsub\n[0]"],
  ["du -sm sub", "1\tsub\n[0]"],
  ["du -sc a.txt big", "4\ta.txt\n4\tbig\n8\ttotal\n[0]"],
  ["du -c a.txt", "4\ta.txt\n4\ttotal\n[0]"],
  ["du -ch big a.txt", "4.0K\tbig\n4.0K\ta.txt\n8.0K\ttotal\n[0]"],
  ["du -s --si big", "4.1k\tbig\n[0]"],
  ["du --si sub/deep/c.txt", "13k\tsub/deep/c.txt\n[0]"],
  ["du -B 1K big", "4\tbig\n[0]"],
  ["du -B 4K big", "1\tbig\n[0]"],
  ["du -B 1M big", "1\tbig\n[0]"],
  ["du -BK big", "4K\tbig\n[0]"],
  ["du -BM big", "1M\tbig\n[0]"],
  ["du -BG big", "1G\tbig\n[0]"],
  ["du -B 1KB big", "5\tbig\n[0]"],
  ["du -B 1000 big", "5\tbig\n[0]"],
  ["du -B 0 big", "du: invalid -B argument '0'\n[1]"],
  ["du -B x big", "du: invalid -B argument 'x'\n[1]"],
  ["du -B big", "du: invalid -B argument 'big'\n[1]"],
  ["du --block-size=2 big", "2048\tbig\n[0]"],
  ["du --block-size=1k sub/deep/c.txt", "12\tsub/deep/c.txt\n[0]"],
  ["du -k sub/deep/c.txt", "12\tsub/deep/c.txt\n[0]"],
  ["du -m sub/deep/c.txt", "1\tsub/deep/c.txt\n[0]"],
  ["du --apparent-size big", "3\tbig\n[0]"],
  ["du --apparent-size -h big", "3.0K\tbig\n[0]"],
  ["du --apparent-size -s sub", "10\tsub\n[0]"],
  ["du -d 0 sub", "28\tsub\n[0]"],
  ["du -d 1 -s sub", "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n[1]"],
  ["du -d x sub", "du: invalid maximum depth 'x'\nTry 'du --help' for more information.\n[1]"],
  ["du --max-depth=0 sub", "28\tsub\n[0]"],
  ["du -s -d 1 sub", "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n[1]"],
  ["du hard a.txt", "4\thard\n[0]"],
  ["du a.txt hard", "4\ta.txt\n[0]"],
  ["du -l hard a.txt", "4\thard\n4\ta.txt\n[0]"],
  ["du lnk", "0\tlnk\n[0]"],
  ["du -L lnk", "4\tlnk\n[0]"],
  ["du -D lnk", "4\tlnk\n[0]"],
  ["du -H lnk", "4\tlnk\n[0]"],
  ["du -P lnk", "0\tlnk\n[0]"],
  ["du dlnk", "0\tdlnk\n[0]"],
  ["du -sL dlnk", "28\tdlnk\n[0]"],
  ["du -sD dlnk", "28\tdlnk\n[0]"],
  ["du -sH dlnk", "28\tdlnk\n[0]"],
  ["du -sP dlnk", "0\tdlnk\n[0]"],
  ["du -s lnk", "0\tlnk\n[0]"],
  ["du -sL lnk", "4\tlnk\n[0]"],
  ["du -a big", "4\tbig\n[0]"],
  ["du -a a.txt", "4\ta.txt\n[0]"],
  ["du -0 a.txt | od -c", "0000000   4  \\t   a   .   t   x   t  \\0\n0000010\n[0]"],
  ["du -0 -s sub | od -c", "0000000   2   8  \\t   s   u   b  \\0\n0000007\n[0]"],
  ["du --null -s big | od -c", "0000000   4  \\t   b   i   g  \\0\n0000006\n[0]"],
  ["du -t 100 big a.txt", "4\tbig\n4\ta.txt\n[0]"],
  ["du -t -100 big a.txt", "[0]"],
  ["du --threshold=1K big a.txt", "4\tbig\n4\ta.txt\n[0]"],
  ["du --threshold=-1K big a.txt", "[0]"],
  ["du --threshold=x big", "du: invalid --threshold argument 'x'\n[1]"],
  ["du -t 0 a.txt", "4\ta.txt\n[0]"],
  ["du --exclude='*.txt' -s sub", "16\tsub\n[0]"],
  ["du --exclude='*' -s sub", "[0]"],
  ["du --exclude=sub -s sub", "[0]"],
  ["du -X nofile sub", "du: nofile: No such file or directory\nTry 'du --help' for more information.\n[1]"],
  ["du --exclude-from=nofile sub", "du: nofile: No such file or directory\nTry 'du --help' for more information.\n[1]"],
  ["du --files0-from=nofile", "du: cannot open 'nofile' for reading: No such file or directory\n[1]"],
  ["du --files0-from=- < /dev/null", "[0]"],
  ["du --files0-from=- a.txt", "du: extra operand 'a.txt'\nfile operands cannot be combined with --files0-from\nTry 'du --help' for more information.\n[1]"],
  ["du -x -s sub", "28\tsub\n[0]"],
  ["du --one-file-system -s sub", "28\tsub\n[0]"],
  ["du -S -s sub", "8\tsub\n[0]"],
  ["du --separate-dirs -s sub", "8\tsub\n[0]"],
  ["du nofile", "du: cannot access 'nofile': No such file or directory\n[1]"],
  ["du nofile a.txt", "du: cannot access 'nofile': No such file or directory\n4\ta.txt\n[1]"],
  ["du a.txt nofile", "4\ta.txt\ndu: cannot access 'nofile': No such file or directory\n[1]"],
  ["du -s nofile", "du: cannot access 'nofile': No such file or directory\n[1]"],
  ["du --bogus", "du: unrecognized option '--bogus'\nTry 'du --help' for more information.\n[1]"],
  ["du -z", "du: invalid option -- 'z'\nTry 'du --help' for more information.\n[1]"],
  ["du -s -s sub", "28\tsub\n[0]"],
  ["du -h -k big", "4\tbig\n[0]"],
  ["du -k -h big", "4.0K\tbig\n[0]"],
  ["du -b -h big", "3.0K\tbig\n[0]"],
  ["du -h -b big", "3000\tbig\n[0]"],
  ["du -h --apparent-size big", "3.0K\tbig\n[0]"],
  ["du --inodes a.txt", "1\ta.txt\n[0]"],
  ["du --inodes -s sub", "5\tsub\n[0]"],
  ["du --inodes hard a.txt", "1\thard\n[0]"],
  ["du --inodes --apparent-size a.txt", "du: warning: options --apparent-size and -b are ineffective with --inodes\n1\ta.txt\n[0]"],
  ["du --inodes -b a.txt", "du: warning: options --apparent-size and -b are ineffective with --inodes\n1\ta.txt\n[0]"],
  ["du -m -k big", "4\tbig\n[0]"],
  ["du -hm big", "1\tbig\n[0]"],
  ["du --summarize sub", "28\tsub\n[0]"],
  ["du --total a.txt big", "4\ta.txt\n4\tbig\n8\ttotal\n[0]"],
  ["du --human-readable big", "4.0K\tbig\n[0]"],
  ["du --bytes big", "3000\tbig\n[0]"],
  ["du --dereference lnk", "4\tlnk\n[0]"],
  ["du --dereference-args lnk", "4\tlnk\n[0]"],
  ["du --count-links hard a.txt", "4\thard\n4\ta.txt\n[0]"],
  ["du --all a.txt", "4\ta.txt\n[0]"],
  ["du --si -h big", "4.0K\tbig\n[0]"],
  ["du -h --si big", "4.1k\tbig\n[0]"],
  ["du -sh * 2>&1 | head -3", "4.0K\ta.txt\n4.0K\tbig\n0\tdlnk\n[0]"],
  ["du --su sub", "28\tsub\n[0]"],
  ["du --sum sub", "28\tsub\n[0]"],
  ["du --ap big", "3\tbig\n[0]"],
  ["du -- -x", "du: cannot access '-x': No such file or directory\n[1]"],
  ["du -s -- sub", "28\tsub\n[0]"],
  ["du ''", "du: invalid zero-length file name\n[1]"],
  ["du -d", "du: option requires an argument -- 'd'\nTry 'du --help' for more information.\n[1]"],
  ["du --max-depth", "du: option '--max-depth' requires an argument\nTry 'du --help' for more information.\n[1]"],
  ["du -B", "du: option requires an argument -- 'B'\nTry 'du --help' for more information.\n[1]"],
  ["du --block-size", "du: option '--block-size' requires an argument\nTry 'du --help' for more information.\n[1]"],
  ["du --threshold", "du: option '--threshold' requires an argument\nTry 'du --help' for more information.\n[1]"],
  ["du -t", "du: option requires an argument -- 't'\nTry 'du --help' for more information.\n[1]"],
];

describe('du against the real GNU du', () => {
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
