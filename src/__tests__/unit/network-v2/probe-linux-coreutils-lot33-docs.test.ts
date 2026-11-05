/*
 * install, mktemp, timeout and dd rejected --help and --version ('missing file operand', 'unrecognized option', 'unrecognized operand') because they parse
 * their own line and never reached CoreutilsDocs. refuseUnknownGnuOption now answers a sole --help / --version for a command that has docs but no option
 * set, which is also how GNU dd, install, mktemp and timeout behave (parse_gnu_standard_options_only). The texts come from the real binaries.
 *
 * Every expected string was produced by the real coreutils 9.4 of the dev container; the version number and year are rewritten to the simulated 8.32 / 2020.

 * The docs entries of touch, who, yes and stty were also missing; pinky, chcon and runcon do not exist in the simulator and are not
 * faked (TODO.md).
 *
 * Measured against the commit before (worktree): 13 of 16 cases fall. The 3 that pass either way ("who --help", "who --version", "touch --version" through their own
 * handlers) are witnesses of the lab.
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
  ["install --help | head -2", "Usage: install [OPTION]... [-T] SOURCE DEST\n  or:  install [OPTION]... SOURCE... DIRECTORY\n[0]"],
  ["install --version | head -2", "install (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["mktemp --help | head -2", "Usage: mktemp [OPTION]... [TEMPLATE]\nCreate a temporary file or directory, safely, and print its name.\n[0]"],
  ["mktemp --version | head -2", "mktemp (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["touch --help | head -2", "Usage: touch [OPTION]... FILE...\nUpdate the access and modification times of each FILE to the current time.\n[0]"],
  ["touch --version | head -2", "touch (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["who --help | head -2", "Usage: who [OPTION]... [ FILE | ARG1 ARG2 ]\nPrint information about users who are currently logged in.\n[0]"],
  ["who --version | head -2", "who (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["yes --help | head -2", "Usage: yes [STRING]...\n  or:  yes OPTION\n[0]"],
  ["yes --version | head -2", "yes (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["stty --help | head -2", "Usage: stty [-F DEVICE | --file=DEVICE] [SETTING]...\n  or:  stty [-F DEVICE | --file=DEVICE] [-a|--all]\n[0]"],
  ["stty --version | head -2", "stty (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["timeout --help | head -2", "Usage: timeout [OPTION] DURATION COMMAND [ARG]...\n  or:  timeout [OPTION]\n[0]"],
  ["timeout --version | head -2", "timeout (GNU coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
  ["dd --help | head -2", "Usage: dd [OPERAND]...\n  or:  dd OPTION\n[0]"],
  ["dd --version | head -2", "dd (coreutils) 8.32\nCopyright (C) 2020 Free Software Foundation, Inc.\n[0]"],
];

describe('--help and --version of install, mktemp, timeout, dd, touch, who, yes, stty', () => {
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
