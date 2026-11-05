/*
 * mount and umount took any dash word as an option, mount -o / -t with no value swallowed nothing, umount with no operand said 'bad usage' without the
 * 'Try' line, umount answered 'not mounted.' for a path that does not exist (the real one says 'no mount point specified.') with status 1 where util-linux
 * returns 32, and several operands returned the status of the first. mountUsageRefusal reads the util-linux option sets through the shared getopt reader,
 * umount walks every operand and answers 64 (some failed) when more than one was given.
 *
 * Every expected string was produced by the real binaries of the dev container (util-linux 2.39.3).
 *
 * Measured against the commit before (worktree): 13 of 15 cases fall. The 2 that pass either way are the mount lines already right at base ('mount /nosuch' and
 * 'mount -t tmpfs tmpfs'); they double as witnesses of the lab.
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
  ["mount -x", "mount: invalid option -- 'x'\nTry 'mount --help' for more information.\n[1]"],
  ["mount --nosuch", "mount: unrecognized option '--nosuch'\nTry 'mount --help' for more information.\n[1]"],
  ["mount -o", "mount: option requires an argument -- 'o'\nTry 'mount --help' for more information.\n[1]"],
  ["mount -t", "mount: option requires an argument -- 't'\nTry 'mount --help' for more information.\n[1]"],
  ["mount -lx", "mount: invalid option -- 'x'\nTry 'mount --help' for more information.\n[1]"],
  ["mount --types", "mount: option '--types' requires an argument\nTry 'mount --help' for more information.\n[1]"],
  ["umount -x", "umount: invalid option -- 'x'\nTry 'umount --help' for more information.\n[1]"],
  ["umount --nosuch", "umount: unrecognized option '--nosuch'\nTry 'umount --help' for more information.\n[1]"],
  ["umount -t", "umount: option requires an argument -- 't'\nTry 'umount --help' for more information.\n[1]"],
  ["umount", "umount: bad usage\nTry 'umount --help' for more information.\n[1]"],
  ["umount nosuch", "umount: nosuch: no mount point specified.\n[32]"],
  ["umount /nosuch", "umount: /nosuch: no mount point specified.\n[32]"],
  ["umount /etc /nosuch", "umount: /etc: not mounted.\numount: /nosuch: no mount point specified.\n[64]"],
  ["mount /nosuch", "mount: /nosuch: can't find in /etc/fstab.\n[1]"],
  ["mount -t tmpfs tmpfs", "mount: tmpfs: can't find in /etc/fstab.\n[1]"]
];

describe('mount and umount grammar and statuses against the real binaries', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`cd /tmp/ff; ${command} 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
