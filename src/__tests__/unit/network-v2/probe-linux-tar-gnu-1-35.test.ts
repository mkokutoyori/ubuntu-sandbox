/*
/*
 * tar was a toy: three operations, a hand-rolled option list and no symbolic links. TarCommand.ts parses the GNU
 * tar 1.35 grammar (old bundled form, attached arguments, unique-prefix long options, positional --exclude and -C),
 * creates (symbolic links kept, -h, --no-recursion, --transform, -T, -X, -P), lists (member arguments, wildcards,
 * anchoring, the 'Not found in archive' summary, the verbose line with owner/group, --numeric-owner), extracts
 * (--strip-components, --one-top-level, -O, -k, --skip-old-files, --overwrite, -m, -p, -C), appends and updates
 * (-r, -u), compares (-d) and deletes members (--delete), reads and writes the archive on standard streams, and
 * reports GNU's diagnostics with their exit statuses. The member store stays the simulator's envelope.
 *
 * Every expected string was produced by the real GNU tar 1.35 of the dev container, by running the identical
 * line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory rewritten to /tmp/ff).
 * Listings are sorted because the real tar walks directories in the host's readdir order; owner names are
 * measured as root; diagnostics printed on standard error are compared only where the line redirects them.
 *
 * Measured against the commit before (worktree): 79 of 112 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p d/sub; printf 'hello\\n' > d/a.txt; printf 'world\\n' > d/sub/b.txt; ln -s a.txt d/lnk; printf 'x\\n' > top; chmod 640 d/a.txt";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["tar cf t.tar d; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cvf t.tar d | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["ROOT:tar cf t.tar d; tar tvf t.tar | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r----- root/root         6 D d/a.txt\n-rw-r--r-- root/root         6 D d/sub/b.txt\ndrwxr-xr-x root/root         0 D d/\ndrwxr-xr-x root/root         0 D d/sub/\nlrwxrwxrwx root/root         0 D d/lnk -> a.txt\n[0]"],
  ["tar cf t.tar d top; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\ntop\n[0]"],
  ["tar cf t.tar d; mkdir out; tar xf t.tar -C out; ls -1 out/d", "a.txt\nlnk\nsub\n[0]"],
  ["tar cf t.tar d; mkdir out; tar xvf t.tar -C out | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; rm -r d; tar xf t.tar; ls -1 d; stat -c %a d/a.txt; readlink d/lnk", "a.txt\nlnk\nsub\n640\na.txt\n[0]"],
  ["tar cf t.tar d; mkdir out; tar xf t.tar --strip-components=1 -C out; ls -1 out", "a.txt\nlnk\nsub\n[0]"],
  ["tar cf t.tar d; mkdir out; tar xf t.tar --strip-components=2 -C out; ls -1 out", "b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --strip-components=1 | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar czf t.tgz d; tar tzf t.tgz | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar czf t.tgz d; tar tf t.tgz | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cJf t.txz d; tar tJf t.txz | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cjf t.tbz d; tar tjf t.tbz | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar --exclude='*.txt' -cf t.tar d; tar tf t.tar | sort", "d/\nd/lnk\nd/sub/\n[0]"],
  ["tar -cf t.tar --exclude=sub d; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\n[0]"],
  ["tar -cf t.tar --exclude=d/sub d; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\n[0]"],
  ["tar -cf t.tar --exclude='sub*' d; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\n[0]"],
  ["tar -cf t.tar --exclude='*/a.txt' d; tar tf t.tar | sort", "d/\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cf t.tar --exclude='a.txt' d; tar tf t.tar | sort", "d/\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cf t.tar --exclude=a.txt --exclude=lnk d; tar tf t.tar | sort", "d/\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cf t.tar d --exclude=sub; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar -C d .; tar tf t.tar | sort", "./\n./a.txt\n./lnk\n./sub/\n./sub/b.txt\n[0]"],
  ["tar cf t.tar -C d a.txt sub; tar tf t.tar | sort", "a.txt\nsub/\nsub/b.txt\n[0]"],
  ["tar cf t.tar d; tar rf t.tar top; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\ntop\n[0]"],
  ["tar cf t.tar d; tar uf t.tar d; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar uf t.tar top; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\ntop\n[0]"],
  ["tar cf t.tar d; tar --list -f t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar d/a.txt", "d/a.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar d/sub | sort", "d/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar d/ | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar nonesuch", "tar: nonesuch: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar tf t.tar d/a.txt nonesuch", "d/a.txt\ntar: nonesuch: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar xf t.tar nonesuch", "tar: nonesuch: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar xf t.tar d/a.txt; ls -1 d", "a.txt\nlnk\nsub\n[0]"],
  ["tar cf t.tar nofile", "tar: nofile: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar", "tar: Cowardly refusing to create an empty archive\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar cf", "tar: Old option 'f' requires an argument.\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar xf", "tar: Old option 'f' requires an argument.\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar", "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar --bogus", "tar: unrecognized option '--bogus'\nTry 'tar --help' or 'tar --usage' for more information.\n[64]"],
  ["tar -y", "tar: invalid option -- 'y'\nTry 'tar --help' or 'tar --usage' for more information.\n[64]"],
  ["tar -cfz", "tar: Cowardly refusing to create an empty archive\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar cz", "tar: Cowardly refusing to create an empty archive\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar xf nofile.tar", "tar: nofile.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar tf nofile.tar", "tar: nofile.tar: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar -x", "tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar df t.tar; echo $?", "0\n[0]"],
  ["tar cf t.tar d; echo y >> d/a.txt; tar df t.tar; echo $?", "d/a.txt: Size differs\n1\n[0]"],
  ["tar cf t.tar d; chmod 600 d/a.txt; tar df t.tar; echo $?", "d/a.txt: Mode differs\n1\n[0]"],
  ["tar cf t.tar d; tar --delete -f t.tar d/a.txt; tar tf t.tar | sort", "d/\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar --delete -f t.tar d/sub; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\n[0]"],
  ["tar cf - d | tar tf - | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf - d | tar xf - -C /tmp; ls -1 /tmp/d | head -0", "[0]"],
  ["tar cf t.tar d; tar xOf t.tar d/a.txt", "hello\n[0]"],
  ["tar cf t.tar d; tar xOf t.tar d/sub/b.txt d/a.txt", "world\nhello\n[0]"],
  ["tar cf t.tar d --transform='s/^d/e/'; tar tf t.tar | sort", "e/\ne/a.txt\ne/lnk\ne/sub/\ne/sub/b.txt\n[0]"],
  ["tar cf t.tar --transform='s/^d/e/' d; tar tf t.tar | sort", "e/\ne/a.txt\ne/lnk\ne/sub/\ne/sub/b.txt\n[0]"],
  ["tar cf t.tar d; mkdir o; tar xf t.tar --transform='s/^d/e/' -C o; ls -1 o", "e\n[0]"],
  ["tar cf t.tar d; mkdir o; tar xf t.tar --transform='s,a,A,g' -C o; ls -1 o/d", "A.txt\nlnk\nsub\n[0]"],
  ["tar cf t.tar --no-recursion d; tar tf t.tar | sort", "d/\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --no-recursion d", "d/\n[0]"],
  ["tar cf t.tar d; mkdir o; tar xf t.tar --one-top-level=z -C o; ls -1 o/z", "d\n[0]"],
  ["tar cf t.tar d; mkdir o; tar xf t.tar --one-top-level -C o; ls -1 o", "t\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --wildcards '*.txt' | sort", "d/a.txt\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --wildcards 'd/*' | sort", "d/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --wildcards 'a.txt'", "tar: a.txt: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar tf t.tar --wildcards --no-anchored 'a.txt'", "d/a.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --wildcards --no-wildcards-match-slash '*.txt'", "tar: *.txt: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar tf t.tar '*.txt'", "tar: Pattern matching characters used in file names\ntar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning\ntar: *.txt: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["ROOT:tar cf t.tar d; tar tvf t.tar --numeric-owner | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r----- 0/0               6 D d/a.txt\n-rw-r--r-- 0/0               6 D d/sub/b.txt\ndrwxr-xr-x 0/0               0 D d/\ndrwxr-xr-x 0/0               0 D d/sub/\nlrwxrwxrwx 0/0               0 D d/lnk -> a.txt\n[0]"],
  ["tar cf t.tar d; rm -r d; tar xf t.tar -k; ls -1 d; stat -c %a d/a.txt", "a.txt\nlnk\nsub\n640\n[0]"],
  ["tar cf t.tar d; tar xf t.tar --skip-old-files; echo $?", "0\n[0]"],
  ["tar cf t.tar d; tar xf t.tar --overwrite; echo $?", "0\n[0]"],
  ["tar cf t.tar d; tar xf t.tar; echo $?", "0\n[0]"],
  ["tar cf t.tar d; rm -r d; tar xf t.tar --no-same-permissions; stat -c %a d/a.txt", "640\n[0]"],
  ["tar cf t.tar d; rm -r d; tar xf t.tar -p; stat -c %a d/a.txt", "640\n[0]"],
  ["tar cf t.tar d; tar xf t.tar -m -v | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d -P; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; tar tf t.tar --totals | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cvzf t.tgz d top | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\ntop\n[0]"],
  ["tar -zcvf t.tgz d | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -c -f t.tar d; tar -t -f t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cf t.tar -v d | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar -cvf t.tar d | wc -l", "5\n[0]"],
  ["ROOT:tar cf t.tar d; tar -tf t.tar -v | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r----- root/root         6 D d/a.txt\n-rw-r--r-- root/root         6 D d/sub/b.txt\ndrwxr-xr-x root/root         0 D d/\ndrwxr-xr-x root/root         0 D d/sub/\nlrwxrwxrwx root/root         0 D d/lnk -> a.txt\n[0]"],
  ["ROOT:tar cf t.tar d; tar tvf t.tar d/sub | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r--r-- root/root         6 D d/sub/b.txt\ndrwxr-xr-x root/root         0 D d/sub/\n[0]"],
  ["tar --create --file=t.tar d; tar --list --file t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar --exclude", "tar: option '--exclude' requires an argument\nTry 'tar --help' or 'tar --usage' for more information.\n[64]"],
  ["tar --strip-components=x -xf t.tar", "tar: x: Invalid number of elements\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar -xf t.tar --transform=bogus", "tar: Invalid transform expression\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar --file", "tar: option '--file' requires an argument\nTry 'tar --help' or 'tar --usage' for more information.\n[64]"],
  ["tar cf t.tar d; tar xf t.tar -C nodir", "tar: nodir: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar -T nofile -cf t.tar", "tar: nofile: Cannot stat: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["printf 'd/a.txt\\ntop\\n' > list; tar -T list -cf t.tar; tar tf t.tar | sort", "d/a.txt\ntop\n[0]"],
  ["printf '*.txt\\n' > pats; tar -X pats -cf t.tar d; tar tf t.tar | sort", "d/\nd/lnk\nd/sub/\n[0]"],
  ["tar cf t.tar d; tar xf t.tar -X nofile", "tar: nofile: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar -cf t.tar d -C /tmp; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d nofile 2>/dev/null; tar tf t.tar | sort", "d/\nd/a.txt\nd/lnk\nd/sub/\nd/sub/b.txt\n[0]"],
  ["tar cf t.tar d; rm d/a.txt; tar df t.tar 2>/dev/null; echo $?", "1\n[0]"],
  ["tar cf t.tar d; tar --delete -f t.tar nonesuch 2>/dev/null; echo $?", "2\n[0]"],
  ["tar cf t.tar d; tar xf t.tar -k 2>/dev/null; echo $?", "2\n[0]"],
  ["tar cf t.tar d; tar tf t.tar '*.txt' 2>&1", "tar: Pattern matching characters used in file names\ntar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning\ntar: *.txt: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar cf t.tar d; tar tf t.tar --no-wildcards '*.txt' 2>&1", "tar: *.txt: Not found in archive\ntar: Exiting with failure status due to previous errors\n[2]"],
  ["tar -cfz", "tar: Cowardly refusing to create an empty archive\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar -cf", "tar: option requires an argument -- 'f'\nTry 'tar --help' or 'tar --usage' for more information.\n[64]"],
  ["tar -xfz", "tar: z: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar --strip-components=x -xf t.tar", "tar: x: Invalid number of elements\nTry 'tar --help' or 'tar --usage' for more information.\n[2]"],
  ["tar -T nofile -cf t.tar", "tar: nofile: Cannot stat: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["tar cf t.tar d; tar xf t.tar -X nofile", "tar: nofile: No such file or directory\ntar: Error is not recoverable: exiting now\n[2]"],
  ["ROOT:tar cf t.tar d; tar tvf t.tar --numeric-owner | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r----- 0/0               6 D d/a.txt\n-rw-r--r-- 0/0               6 D d/sub/b.txt\ndrwxr-xr-x 0/0               0 D d/\ndrwxr-xr-x 0/0               0 D d/sub/\nlrwxrwxrwx 0/0               0 D d/lnk -> a.txt\n[0]"],
  ["ROOT:tar cf t.tar d; tar tvf t.tar | sort | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+/D/'", "-rw-r----- root/root         6 D d/a.txt\n-rw-r--r-- root/root         6 D d/sub/b.txt\ndrwxr-xr-x root/root         0 D d/\ndrwxr-xr-x root/root         0 D d/sub/\nlrwxrwxrwx root/root         0 D d/lnk -> a.txt\n[0]"],
];

describe('tar against the real GNU tar', () => {
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
