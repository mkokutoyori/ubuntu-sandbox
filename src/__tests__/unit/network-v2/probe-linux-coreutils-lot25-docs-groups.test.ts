/*
 * --help and --version of uname, nproc, logname, users, whoami, sleep, nice, tty and stat were never answered (the registry commands
 * ran as if no option had been given; stat printed a corrupted usage with a stray 'Usage: %s' line). refuseUnknownGnuOption
 * now answers --help and --version in getopt order, from CoreutilsDocs, at every call site that already runs the guard
 * (executor and the four LinuxMachine sites); logname and users gained their option sets; nproc evaluates --ignore=N
 * (invalid number, overflow, floor at 1); groups takes several users, quotes 'no such user' and exits 1 when one is unknown.
 *
 * Every expected string was produced by the real coreutils 9.4 of the dev container; the version number and year are
 * rewritten to the simulated distribution's 8.32 / 2020 (CoreutilsDocs convention), the 'line 1: ' prefix of bash -c dropped.
 * Host-dependent rows (nproc without --ignore, groups of the invoking user) are not pinned.
 *
 * Measured against the commit before (worktree): 33 of 41 cases fall. The 8 that pass either way are non-regressions the guard
 * already refused ('uname -z --help', 'uname extra', 'nproc extra', 'nproc --nosuch', 'whoami extra', 'groups -x') or witnesses
 * of the lab ('groups root', 'groups -- root').
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
  ["uname --help | head -3", "Usage: uname [OPTION]...\nPrint certain system information.  With no OPTION, same as -s.\n\n[0]"],
  ["uname --version | tail -2", "\nWritten by David MacKenzie.\n[0]"],
  ["uname -z --help", "uname: invalid option -- 'z'\nTry 'uname --help' for more information.\n[1]"],
  ["uname --help -z", "Usage: uname [OPTION]...\nPrint certain system information.  With no OPTION, same as -s.\n\n  -a, --all                print all information, in the following order,\n                             except omit -p and -i if unknown:\n  -s, --kernel-name        print the kernel name\n  -n, --nodename           print the network node hostname\n  -r, --kernel-release     print the kernel release\n  -v, --kernel-version     print the kernel version\n  -m, --machine            print the machine hardware name\n  -p, --processor          print the processor type (non-portable)\n  -i, --hardware-platform  print the hardware platform (non-portable)\n  -o, --operating-system   print the operating system\n      --help        display this help and exit\n      --version     output version information and exit\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/uname>\nor available locally via: info '(coreutils) uname invocation'\n[0]"],
  ["uname -a --version | head -1", "uname (GNU coreutils) 8.32\n[0]"],
  ["uname extra", "uname: extra operand 'extra'\nTry 'uname --help' for more information.\n[1]"],
  ["nproc --ignore=1000", "1\n[0]"],
  ["nproc --ignore=x", "nproc: invalid number: 'x'\n[1]"],
  ["nproc --ignore=", "nproc: invalid number: ''\n[1]"],
  ["nproc --ignore=-1", "nproc: invalid number: '-1'\n[1]"],
  ["nproc --ignore=1.5", "nproc: invalid number: '1.5'\n[1]"],
  ["nproc --ignore=99999999999999999999", "nproc: invalid number: '99999999999999999999': Value too large for defined data type\n[1]"],
  ["nproc --help | head -1", "Usage: nproc [OPTION]...\n[0]"],
  ["nproc extra", "nproc: extra operand 'extra'\nTry 'nproc --help' for more information.\n[1]"],
  ["nproc --nosuch", "nproc: unrecognized option '--nosuch'\nTry 'nproc --help' for more information.\n[1]"],
  ["logname extra", "logname: extra operand 'extra'\nTry 'logname --help' for more information.\n[1]"],
  ["logname --help | head -2", "Usage: logname [OPTION]\nPrint the user's login name.\n[0]"],
  ["logname --version | head -1", "logname (GNU coreutils) 8.32\n[0]"],
  ["logname -x", "logname: invalid option -- 'x'\nTry 'logname --help' for more information.\n[1]"],
  ["users --help | head -2", "Usage: users [OPTION]... [FILE]\nOutput who is currently logged in according to FILE.\n[0]"],
  ["users --nosuch", "users: unrecognized option '--nosuch'\nTry 'users --help' for more information.\n[1]"],
  ["whoami --help | head -2", "Usage: whoami [OPTION]...\nPrint the user name associated with the current effective user ID.\n[0]"],
  ["whoami --version | head -1", "whoami (GNU coreutils) 8.32\n[0]"],
  ["whoami extra", "whoami: extra operand 'extra'\nTry 'whoami --help' for more information.\n[1]"],
  ["sleep --version", "sleep (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by Jim Meyering and Paul Eggert.\n[0]"],
  ["sleep --help | head -2", "Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\n[0]"],
  ["nice --help | head -2", "Usage: nice [OPTION] [COMMAND [ARG]...]\nRun COMMAND with an adjusted niceness, which affects process scheduling.\n[0]"],
  ["nice --version", "nice (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\nThis is free software: you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n\nWritten by David MacKenzie.\n[0]"],
  ["tty --help | head -2", "Usage: tty [OPTION]...\nPrint the file name of the terminal connected to standard input.\n[0]"],
  ["tty --version | head -1", "tty (GNU coreutils) 8.32\n[0]"],
  ["stat --help | head -3", "Usage: stat [OPTION]... FILE...\nDisplay file or file system status.\n\n[0]"],
  ["stat --help | wc -l", "89\n[0]"],
  ["groups nosuchuser", "groups: 'nosuchuser': no such user\n[1]"],
  ["groups root 2>&1", "root : root\n[0]"],
  ["groups root nosuch", "root : root\ngroups: 'nosuch': no such user\n[1]"],
  ["groups nosuch root", "groups: 'nosuch': no such user\nroot : root\n[1]"],
  ["groups root daemon", "root : root\ndaemon : daemon\n[0]"],
  ["groups -- root", "root : root\n[0]"],
  ["groups 0", "groups: '0': no such user\n[1]"],
  ["groups --help | head -1", "Usage: groups [OPTION]... [USERNAME]...\n[0]"],
  ["groups -x", "groups: invalid option -- 'x'\nTry 'groups --help' for more information.\n[1]"],
];

describe('uname nproc logname users whoami sleep nice tty stat groups against the real coreutils', () => {
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
