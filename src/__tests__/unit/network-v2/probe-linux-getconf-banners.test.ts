/*
 * getconf answered a usage text for --version, took any dash word as an option, accepted a pathname for a non-path variable and none for a path
 * variable, listed LONG_MAX and _POSIX2_VERSION (variables the real getconf rejects) and carried glibc 2.39 where the rest of the machine (getent) says
 * 2.35. runGetconf now follows glibc getconf.c: --help / --version only as the first word, -vSPEC / -v SPEC, -a with at most one path, one or two
 * operands, path variables (PATH_MAX, NAME_MAX, FILESIZEBITS, _POSIX_NO_TRUNC...) requiring the path and the others refusing it, 'Unrecognized variable'
 * and the usage on stderr with status 2. ls, dir and vdir gained their --help / --version texts (CoreutilsDocs), and gunzip / zcat answer --version
 * and --help with their own wrapper banners while -V and -h still print gzip's, as the real scripts do.
 *
 * Every expected string was produced by the real binaries of the dev container (getconf glibc 2.39, coreutils 9.4, gzip 1.12); versions and years
 * are rewritten to the simulated distribution (glibc 2.35, coreutils 8.32 / 2020), the 'line 1: ' prefix of bash -c dropped.
 *
 * Measured against the commit before (worktree): 32 of 60 cases fall. The 28 that pass either way are the variable lookups that were already right (LONG_BIT, ARG_MAX, NAME_MAX /,
 * PAGESIZE...) and the gzip banners that were already shared; they double as witnesses of the lab.
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
  ["getconf", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf nosuch", "getconf: Unrecognized variable `nosuch'\n[2]"],
  ["getconf nosuch /", "getconf: Unrecognized variable `nosuch'\n[2]"],
  ["getconf nosuch a b", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf PATH_MAX", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf PATH_MAX /", "4096\n[0]"],
  ["getconf PATH_MAX / extra", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf PAGESIZE extra", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf PAGESIZE /", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf -v POSIX_V7_LP64_OFF64 LONG_BIT", "64\n[0]"],
  ["getconf -v nosuch LONG_BIT", "64\n[0]"],
  ["getconf -v", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf -vPOSIX_V7_LP64_OFF64 LONG_BIT", "64\n[0]"],
  ["getconf -a / extra", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf -a | wc -l | grep -c .", "1\n[0]"],
  ["getconf --all", "getconf: Unrecognized variable `--all'\n[2]"],
  ["getconf LONG_BIT", "64\n[0]"],
  ["getconf ARG_MAX", "2097152\n[0]"],
  ["getconf NAME_MAX /", "255\n[0]"],
  ["getconf NAME_MAX", "Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]\n[2]"],
  ["getconf _POSIX_VERSION", "200809\n[0]"],
  ["getconf CHAR_BIT", "8\n[0]"],
  ["getconf INT_MAX", "2147483647\n[0]"],
  ["getconf CLK_TCK", "100\n[0]"],
  ["getconf HOST_NAME_MAX", "64\n[0]"],
  ["getconf LOGIN_NAME_MAX", "256\n[0]"],
  ["getconf PAGE_SIZE", "4096\n[0]"],
  ["getconf -V", "getconf: Unrecognized variable `-V'\n[2]"],
  ["getconf --usage", "getconf: Unrecognized variable `--usage'\n[2]"],
  ["getconf --help", "Usage: getconf [-v SPEC] VAR\n  or:  getconf [-v SPEC] PATH_VAR PATH\n\nGet the configuration value for variable VAR, or for variable PATH_VAR\nfor path PATH.  If SPEC is given, give values for compilation\nenvironment SPEC.\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getconf --version", "getconf (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\nThis is free software; see the source for copying conditions.  There is NO\nwarranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.\nWritten by Roland McGrath.\n[0]"],
  ["getconf FILESIZEBITS /", "64\n[0]"],
  ["getconf _POSIX_CHOWN_RESTRICTED /", "1\n[0]"],
  ["getconf _POSIX_NO_TRUNC /", "1\n[0]"],
  ["getconf _POSIX_VDISABLE /", "0\n[0]"],
  ["getconf POSIX_ALLOC_SIZE_MIN /", "4096\n[0]"],
  ["getconf POSIX2_SYMLINKS /", "1\n[0]"],
  ["getconf POSIX2_VERSION", "200809\n[0]"],
  ["getconf _POSIX2_VERSION", "getconf: Unrecognized variable `_POSIX2_VERSION'\n[2]"],
  ["getconf LONG_MAX", "getconf: Unrecognized variable `LONG_MAX'\n[2]"],
  ["getconf -x", "getconf: Unrecognized variable `-x'\n[2]"],
  ["getconf -v X nosuch", "getconf: Unrecognized variable `nosuch'\n[2]"],
  ["getconf PATH_MAX /nosuch", "4096\n[0]"],
  ["gunzip -h | head -2", "Usage: gzip [OPTION]... [FILE]...\nCompress or uncompress FILEs (by default, compress FILES in-place).\n[0]"],
  ["gunzip --help | head -2", "Usage: /usr/bin/gunzip [OPTION]... [FILE]...\nUncompress FILEs (by default, in-place).\n[0]"],
  ["gunzip -V | head -1", "gzip 1.12\n[0]"],
  ["gunzip --version | head -3", "gunzip (gzip) 1.12\nCopyright (C) 2007, 2011-2018 Free Software Foundation, Inc.\nThis is free software.  You may redistribute copies of it under the terms of\n[0]"],
  ["zcat -h | head -1", "Usage: gzip [OPTION]... [FILE]...\n[0]"],
  ["zcat --help | head -1", "Usage: /usr/bin/zcat [OPTION]... [FILE]...\n[0]"],
  ["zcat -V | head -1", "gzip 1.12\n[0]"],
  ["zcat --version | head -1", "zcat (gzip) 1.12\n[0]"],
  ["gzip -h | head -1", "Usage: gzip [OPTION]... [FILE]...\n[0]"],
  ["gzip --help | head -1", "Usage: gzip [OPTION]... [FILE]...\n[0]"],
  ["gzip -V | head -1", "gzip 1.12\n[0]"],
  ["gzip --version | head -1", "gzip 1.12\n[0]"],
  ["ls --version | head -1", "ls (GNU coreutils) 8.32\n[0]"],
  ["ls --help | head -2", "Usage: ls [OPTION]... [FILE]...\nList information about the FILEs (the current directory by default).\n[0]"],
  ["dir --version | head -1", "dir (GNU coreutils) 8.32\n[0]"],
  ["vdir --version | head -1", "vdir (GNU coreutils) 8.32\n[0]"],
  ["dir --help | head -1", "Usage: dir [OPTION]... [FILE]...\n[0]"],
];

describe('getconf, ls --help/--version, gunzip and zcat banners against the real binaries', () => {
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
