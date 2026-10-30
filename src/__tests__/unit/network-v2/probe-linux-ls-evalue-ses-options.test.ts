/*
 * ls accepted dozens of options and evaluated a handful: -A, -p, -S (a
 * directory weighs 4096), -X, -v, -s, -h, -Q, -m, -x, -C (column widths and
 * tabs), -I, --hide, -B, --group-directories-first, -T, -w, -Z, --zero,
 * --sort, --format, --indicator-style and the "Valid arguments are:" blocks
 * were ignored or wrong, `ls -R` named its sub-directories without "./",
 * and the `total` line counted 512-byte units where ls counts KiB.
 *
 * Every expected string below was produced by the real GNU ls 9.4 of the dev
 * container on the same tree (alpha.txt 4 bytes, beta.log 12, gamma.sh
 * executable, notes~, link -> alpha.txt, delta/ with inner/z and y, .cache,
 * .hidden). Names are lower-case so the C-locale order of the container and
 * the en_US order of the simulator agree. Not covered because the values
 * depend on the clock or the file system: dates, inode numbers, atime/ctime
 * sorts, `--time=birth` (no birth time is modelled), -U/-f order.
 *
 * Measured with `git stash`: 38 cases, 30 fall before the change; the 8 that
 * pass either way are the plain listings and witnesses (-1, -1a, -1r, -1d,
 * -1B, -1sk, nothere, delta alpha.txt).
 * The diagnostics use straight quotes, as the rest of the simulator does
 * (the container's UTF-8 locale prints curly ones).
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

describe('ls evaluates what it accepts, like GNU ls 9.4', () => {
  it.each<[string, string]>([
    ["-1", "alpha.txt\nbeta.log\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1A", ".cache\n.hidden\nalpha.txt\nbeta.log\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1a", ".\n..\n.cache\n.hidden\nalpha.txt\nbeta.log\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1p", "alpha.txt\nbeta.log\ndelta/\ngamma.sh\nlink\nnotes~"],
    ["-1F", "alpha.txt\nbeta.log\ndelta/\ngamma.sh*\nlink@\nnotes~"],
    ["-1S", "delta\nbeta.log\ngamma.sh\nlink\nalpha.txt\nnotes~"],
    ["-1X", "delta\nlink\nnotes~\nbeta.log\ngamma.sh\nalpha.txt"],
    ["-1v", "alpha.txt\nbeta.log\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1r", "notes~\nlink\ngamma.sh\ndelta\nbeta.log\nalpha.txt"],
    ["-1B", "alpha.txt\nbeta.log\ndelta\ngamma.sh\nlink"],
    ["-1s", "total 20\n4 alpha.txt\n4 beta.log\n4 delta\n4 gamma.sh\n0 link\n4 notes~"],
    ["-1sh", "total 20K\n4.0K alpha.txt\n4.0K beta.log\n4.0K delta\n4.0K gamma.sh\n   0 link\n4.0K notes~"],
    ["-1sk", "total 20\n4 alpha.txt\n4 beta.log\n4 delta\n4 gamma.sh\n0 link\n4 notes~"],
    ["-1Q", "\"alpha.txt\"\n\"beta.log\"\n\"delta\"\n\"gamma.sh\"\n\"link\"\n\"notes~\""],
    ["-m", "alpha.txt, beta.log, delta, gamma.sh, link, notes~"],
    ["-C -w 30", "alpha.txt  delta     link\nbeta.log   gamma.sh  notes~"],
    ["-x -w 30", "alpha.txt  beta.log  delta\ngamma.sh   link      notes~"],
    ["-C -w 0", "alpha.txt  beta.log  delta  gamma.sh  link  notes~"],
    ["-C -T 2 -w 40", "alpha.txt  delta\t\t link\nbeta.log\t gamma.sh  notes~"],
    ["-1 -I *.log", "alpha.txt\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1 --hide=*.txt", "beta.log\ndelta\ngamma.sh\nlink\nnotes~"],
    ["-1 --group-directories-first", "delta\nalpha.txt\nbeta.log\ngamma.sh\nlink\nnotes~"],
    ["-1R", ".:\nalpha.txt\nbeta.log\ndelta\ngamma.sh\nlink\nnotes~\n\n./delta:\ninner\ny\n\n./delta/inner:\nz"],
    ["-1 -d delta link", "delta\nlink"],
    ["-1Z", "? alpha.txt\n? beta.log\n? delta\n? gamma.sh\n? link\n? notes~"],
    ["--zero", "alpha.txt\u0000beta.log\u0000delta\u0000gamma.sh\u0000link\u0000notes~\u0000"],
    ["-1 --file-type", "alpha.txt\nbeta.log\ndelta/\ngamma.sh\nlink@\nnotes~"],
    ["-1 --sort=width", "link\ndelta\nnotes~\nbeta.log\ngamma.sh\nalpha.txt"],
    ["-1 --indicator-style=slash", "alpha.txt\nbeta.log\ndelta/\ngamma.sh\nlink\nnotes~"],
    ["-1 --format=commas", "alpha.txt, beta.log, delta, gamma.sh, link, notes~"],
    ["-1 -w abc", "ls: invalid line width: 'abc'"],
    ["-1 --color=bad", "ls: invalid argument 'bad' for '--color'\nValid arguments are:\n  - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information."],
    ["-1 --sort=bad", "ls: invalid argument 'bad' for '--sort'\nValid arguments are:\n  - 'none'\n  - 'time'\n  - 'size'\n  - 'extension'\n  - 'version'\n  - 'width'\nTry 'ls --help' for more information."],
    ["-1 --quoting-style=c", "\"alpha.txt\"\n\"beta.log\"\n\"delta\"\n\"gamma.sh\"\n\"link\"\n\"notes~\""],
    ["-1 delta alpha.txt", "alpha.txt\n\ndelta:\ninner\ny"],
    ["-1 nothere", "ls: cannot access 'nothere': No such file or directory"],
    ["- 1 f", "ls: cannot access '-': No such file or directory\nls: cannot access '1': No such file or directory\nls: cannot access 'f': No such file or directory"],
  ])('ls %s', async (args, expected) => {
    const machine = await lab();
    expect(await machine.executeCommand(`cd /tmp/fx; ls ${args}`)).toBe(expected);
  });

  it('ls -lF marks directories and executables but not the symlink, whose target is shown', async () => {
    const machine = await lab();
    const out = await machine.executeCommand('cd /tmp/fx; ls -lF');
    expect(out).toMatch(/ link -> alpha\.txt$/m);
    expect(out).toMatch(/ gamma\.sh\*$/m);
    expect(out).toMatch(/ delta\/$/m);
  });
});
