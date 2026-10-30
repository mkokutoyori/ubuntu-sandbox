/*
 * du read -a -b -c -d -h -k -m -s and refused every other option as invalid
 * (-S -x -L -l -P -D -H -B -t -0 -X, --apparent-size, --exclude, --si,
 * --inodes, --time, --block-size, --files0-from); its sizes were the byte
 * count rounded up to 1 KiB where du reports allocated 4 KiB blocks (an empty
 * file 0, a symlink 0, a directory 4096), `-h` printed `39B`, and `-b` gave a
 * directory the byte size of its contents plus nothing else.
 *
 * Every expected string below was produced by the real GNU du 9.4 of the dev
 * container on the same tree (alpha.txt 4 bytes, beta.log 12, gamma.sh
 * executable, notes~, link -> alpha.txt, delta/ with inner/z and y, .cache,
 * .hidden). The lines of each answer are compared SORTED: du lists entries in
 * readdir order, which the simulator does not share with a real file system.
 * The diagnostics use straight quotes. Not covered: dates (--time), whose
 * values depend on the clock, and -L with a link visited before its target
 * (readdir order decides which of the two carries the block).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand(
    "mkdir -p /tmp/fx/delta/inner /tmp/fx/.cache; cd /tmp/fx; printf 'aaaa' > alpha.txt; printf 'bbbbbbbbbbbb' > beta.log; "
    + "printf '#!/bin/sh\\n' > gamma.sh; chmod +x gamma.sh; printf 'n' > 'notes~'; : > .hidden; printf '1' > delta/inner/z; "
    + "printf 'zz' > delta/y; ln -s alpha.txt link",
  );
  return machine;
}

const sorted = (text: string): string => text.split('\n').sort().join('\n');

describe('du reports what GNU du 9.4 reports', () => {
  it.each<[string, string]>([
    ["", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-a", "0\t./.hidden\n0\t./link\n16\t./delta\n4\t./.cache\n4\t./alpha.txt\n4\t./beta.log\n4\t./delta/inner/z\n4\t./delta/y\n4\t./gamma.sh\n4\t./notes~\n40\t.\n8\t./delta/inner"],
    ["-b", "0\t./.cache\n1\t./delta/inner\n3\t./delta\n39\t."],
    ["-ab", "0\t./.cache\n0\t./.hidden\n1\t./delta/inner\n1\t./delta/inner/z\n1\t./notes~\n10\t./gamma.sh\n12\t./beta.log\n2\t./delta/y\n3\t./delta\n39\t.\n4\t./alpha.txt\n9\t./link"],
    ["-c", "16\t./delta\n4\t./.cache\n40\t.\n40\ttotal\n8\t./delta/inner"],
    ["-d 0", "40\t."],
    ["-d 1", "16\t./delta\n4\t./.cache\n40\t."],
    ["--max-depth=1", "16\t./delta\n4\t./.cache\n40\t."],
    ["-h", "16K\t./delta\n4.0K\t./.cache\n40K\t.\n8.0K\t./delta/inner"],
    ["-ah", "0\t./.hidden\n0\t./link\n16K\t./delta\n4.0K\t./.cache\n4.0K\t./alpha.txt\n4.0K\t./beta.log\n4.0K\t./delta/inner/z\n4.0K\t./delta/y\n4.0K\t./gamma.sh\n4.0K\t./notes~\n40K\t.\n8.0K\t./delta/inner"],
    ["-k", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-m", "1\t.\n1\t./.cache\n1\t./delta\n1\t./delta/inner"],
    ["-s", "40\t."],
    ["-sh", "40K\t."],
    ["-S", "20\t.\n4\t./.cache\n8\t./delta\n8\t./delta/inner"],
    ["-x", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["--apparent-size", "0\t./.cache\n1\t.\n1\t./delta\n1\t./delta/inner"],
    ["-ab --apparent-size", "0\t./.cache\n0\t./.hidden\n1\t./delta/inner\n1\t./delta/inner/z\n1\t./notes~\n10\t./gamma.sh\n12\t./beta.log\n2\t./delta/y\n3\t./delta\n39\t.\n4\t./alpha.txt\n9\t./link"],
    ["--exclude=*.log", "16\t./delta\n36\t.\n4\t./.cache\n8\t./delta/inner"],
    ["--exclude=*.txt -a", "0\t./.hidden\n0\t./link\n16\t./delta\n36\t.\n4\t./.cache\n4\t./beta.log\n4\t./delta/inner/z\n4\t./delta/y\n4\t./gamma.sh\n4\t./notes~\n8\t./delta/inner"],
    ["-t 1", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-t -1", ""],
    ["--si", "17k\t./delta\n4.1k\t./.cache\n41k\t.\n8.2k\t./delta/inner"],
    ["--inodes", "1\t./.cache\n12\t.\n2\t./delta/inner\n4\t./delta"],
    ["-a --inodes", "1\t./.cache\n1\t./.hidden\n1\t./alpha.txt\n1\t./beta.log\n1\t./delta/inner/z\n1\t./delta/y\n1\t./gamma.sh\n1\t./link\n1\t./notes~\n12\t.\n2\t./delta/inner\n4\t./delta"],
    ["-B 1K", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-BK", "16K\t./delta\n40K\t.\n4K\t./.cache\n8K\t./delta/inner"],
    ["-BM", "1M\t.\n1M\t./.cache\n1M\t./delta\n1M\t./delta/inner"],
    ["--block-size=1", "16384\t./delta\n4096\t./.cache\n40960\t.\n8192\t./delta/inner"],
    ["--block-size=KB", "17kB\t./delta\n41kB\t.\n5kB\t./.cache\n9kB\t./delta/inner"],
    ["-sb", "39\t."],
    ["-sc", "40\t.\n40\ttotal"],
    ["delta", "16\tdelta\n8\tdelta/inner"],
    ["delta alpha.txt", "16\tdelta\n4\talpha.txt\n8\tdelta/inner"],
    ["-s delta alpha.txt", "16\tdelta\n4\talpha.txt"],
    ["-sh .", "40K\t."],
    ["-h --max-depth=0", "40K\t."],
    ["--summarize -c", "40\t.\n40\ttotal"],
    ["-P", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["--threshold=1", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-a --max-depth=1 --exclude=inner", "0\t./.hidden\n0\t./link\n32\t.\n4\t./.cache\n4\t./alpha.txt\n4\t./beta.log\n4\t./gamma.sh\n4\t./notes~\n8\t./delta"],
    ["-D", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-H", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-sk", "40\t."],
    ["-h -k", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-k -h", "16K\t./delta\n4.0K\t./.cache\n40K\t.\n8.0K\t./delta/inner"],
    ["--si -k", "16\t./delta\n4\t./.cache\n40\t.\n8\t./delta/inner"],
    ["-sm", "1\t."],
    ["-BK -h", "16K\t./delta\n4.0K\t./.cache\n40K\t.\n8.0K\t./delta/inner"],
    ["-ac -d 0", "40\t.\n40\ttotal"],
    ["-B abc", "du: invalid -B argument 'abc'"],
    ["-d x", "Try 'du --help' for more information.\ndu: invalid maximum depth 'x'"],
    ["-t x", "du: invalid -t argument 'x'"],
    ["--time=bad", "  - 'atime', 'access', 'use'\n  - 'ctime', 'status'\nTry 'du --help' for more information.\nValid arguments are:\ndu: invalid argument 'bad' for '--time'"],
    ["--time-style=bad --time", "  - 'full-iso'\n  - 'iso'\n  - 'long-iso'\nTry 'du --help' for more information.\nValid arguments are:\ndu: invalid argument 'bad' for 'time style'"],
    ["nothere", "du: cannot access 'nothere': No such file or directory"],
    ["-d 1 -s", "Try 'du --help' for more information.\ndu: warning: summarizing conflicts with --max-depth=1"],
    ["-s -d 1", "Try 'du --help' for more information.\ndu: warning: summarizing conflicts with --max-depth=1"],
    ["-a -s", "Try 'du --help' for more information.\ndu: cannot both summarize and show all entries"],
    ["--zorglub", "Try 'du --help' for more information.\ndu: unrecognized option '--zorglub'"],
    ["-Z", "Try 'du --help' for more information.\ndu: invalid option -- 'Z'"],
    ["-s --inodes", "12\t."],
    ["-sl", "40\t."],
  ])('du %s', async (args, expected) => {
    const machine = await lab();
    expect(sorted(await machine.executeCommand(`cd /tmp/fx; du ${args}`))).toBe(expected);
  });
});
