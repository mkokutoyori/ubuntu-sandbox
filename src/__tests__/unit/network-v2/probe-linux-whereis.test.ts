/*
 * whereis ignored most of its grammar: -x, -- and a missing name were accepted silently, -B/-M/-S swallowed everything up to -f without
 checking for it ('option -f is missing'), -u and -h/--help/-V/--version printed nothing, -l printed bare paths without the bin:/man:/src:
 label, and a path argument was looked up whole. It is now a port of util-linux whereis.c (resolve/Whereis.ts, replacing the approximate
 WhereisResolver): the real directory tables with '*' expansion, PATH/MANPATH, inode de-duplication, the cumulative -b/-m/-s mask that resets
 after a lookup, the filename_equal rules (compressed manual suffixes, s. sources, .C), -u unusual entries, -g globbing, the usage text and the
 'bad usage' / 'not enough arguments' diagnostics with status 1.
 *
 * Every expected string was produced by the real whereis of util-linux 2.39.3 of the dev container; the version is rewritten to the simulated
 * distribution's 2.37.2, the 'line 1: ' prefix of bash -c dropped. Rows whose answer depends on the content of the host's file tree (the 62
 * lookup directories, glob matches over /usr/bin) are not pinned.
 *
 * Measured against the commit before (worktree): 19 of 35 cases fall. The 16 that pass either way are the non-regressions of the lookups that were already right
 * (-b, -m, -s, -bm, -f, -B with -f, nosuch, duplicate names, -S) and double as witnesses of the lab.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["whereis -x", "whereis: bad usage\nTry 'whereis --help' for more information.\n[1]"],
  ["whereis", "whereis: not enough arguments\nTry 'whereis --help' for more information.\n[1]"],
  ["whereis -b ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -m ls", "ls:\n[0]"],
  ["whereis -s ls", "ls:\n[0]"],
  ["whereis -u ls", "[0]"],
  ["whereis -B /bin -f ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -B /bin ls", "whereis: option -f is missing\n[1]"],
  ["whereis -l | head -2", "bin: /usr/bin\nbin: /usr/sbin\n[0]"],
  ["whereis ls nosuch", "ls: /usr/bin/ls\nnosuch:\n[0]"],
  ["whereis -V | head -1", "whereis from util-linux 2.37.2\n[0]"],
  ["whereis -b nosuch", "nosuch:\n[0]"],
  ["whereis -bm ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -f", "[0]"],
  ["whereis -B", "whereis: option -f is missing\n[1]"],
  ["whereis -B /bin", "whereis: option -f is missing\n[1]"],
  ["whereis -b -B /bin -f ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -b -f ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -- ls", "whereis: bad usage\nTry 'whereis --help' for more information.\n[1]"],
  ["whereis /bin/ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -l -b | head -2", "bin: /usr/bin\nbin: /usr/sbin\n[0]"],
  ["whereis -h", "\nUsage:\n whereis [options] [-BMS <dir>... -f] <name>\n\nLocate the binary, source, and manual-page files for a command.\n\nOptions:\n -b         search only for binaries\n -B <dirs>  define binaries lookup path\n -m         search only for manuals and infos\n -M <dirs>  define man and info lookup path\n -s         search only for sources\n -S <dirs>  define sources lookup path\n -f         terminate <dirs> argument list\n -u         search for unusual entries\n -g         interpret name as glob (pathnames pattern)\n -l         output effective lookup paths\n\n -h, --help     display this help\n -V, --version  display version\n\nFor more details see whereis(1).\n[0]"],
  ["whereis --help", "\nUsage:\n whereis [options] [-BMS <dir>... -f] <name>\n\nLocate the binary, source, and manual-page files for a command.\n\nOptions:\n -b         search only for binaries\n -B <dirs>  define binaries lookup path\n -m         search only for manuals and infos\n -M <dirs>  define man and info lookup path\n -s         search only for sources\n -S <dirs>  define sources lookup path\n -f         terminate <dirs> argument list\n -u         search for unusual entries\n -g         interpret name as glob (pathnames pattern)\n -l         output effective lookup paths\n\n -h, --help     display this help\n -V, --version  display version\n\nFor more details see whereis(1).\n[0]"],
  ["whereis -b ls ls", "ls: /usr/bin/ls\nls: /usr/bin/ls\n[0]"],
  ["whereis -S /usr/share/man -f ls", "ls: /usr/bin/ls\n[0]"],
  ["whereis -b -u nosuch", "[0]"],
  ["whereis -u ls nosuch", "[0]"],
  ["whereis -b cat true false", "cat: /usr/bin/cat\ntrue: /usr/bin/true\nfalse: /usr/bin/false\n[0]"],
  ["whereis -B /usr/bin /bin -f cat", "cat: /usr/bin/cat\n[0]"],
  ["whereis -Bx", "whereis: bad usage\nTry 'whereis --help' for more information.\n[1]"],
  ["whereis -u -B /usr/bin /bin -f cat", "[0]"],
  ["whereis -b ../usr/bin/cat", "cat: /usr/bin/cat\n[0]"],
  ["whereis -m -s cat", "cat:\n[0]"],
  ["whereis -msb cat", "cat: /usr/bin/cat\n[0]"],
  ["whereis cat -m", "cat: /usr/bin/cat\n[0]"],
];

describe('whereis against the real whereis', () => {
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
