/*
 * findmnt ignored every option: -n, -o, -r, -P, -J, -t, -S, -T, -M, -f, -x and -V did nothing, an operand did not select a row, a missing target still
 * exited 0, a bad option or column was silent, and the default output was a flat list where util-linux draws the mount tree. runFindmnt now reads the
 * util-linux option set through the shared getopt reader and renders the tree, the list, raw, pairs and JSON forms, picks rows by operand / -S / -T / -M,
 * negates a -t list that starts with 'no', refuses unknown columns ('unknown column: X') and exits 1 when nothing matches.
 *
 * Every expected string was produced by the real findmnt of the dev container (util-linux 2.39.3, version rewritten to 2.37.2). Only the rows present
 * on both machines (/proc, /sys) are compared: the mount tables themselves differ.
 *
 * Measured against the commit before (worktree): all 26 findmnt cases fall; the one case that passes either way is the 'echo witness' line, which proves the lab
 * itself (shell, status suffix, normalisation) is sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo witness", "witness\n[0]"],
  ["findmnt -x", "Success, no errors or warnings detected\n[0]"],
  ["findmnt --nosuch", "findmnt: unrecognized option '--nosuch'\nTry 'findmnt --help' for more information.\n[1]"],
  ["findmnt -t", "findmnt: option requires an argument -- 't'\nTry 'findmnt --help' for more information.\n[1]"],
  ["findmnt -o", "findmnt: option requires an argument -- 'o'\nTry 'findmnt --help' for more information.\n[1]"],
  ["findmnt -V | sed 's/2.39.3/2.37.2/'", "findmnt from util-linux 2.37.2\n[0]"],
  ["findmnt /nosuch", "[1]"],
  ["findmnt -n /nosuch", "[1]"],
  ["findmnt a b", "[1]"],
  ["findmnt -o NOSUCH", "findmnt: unknown column: NOSUCH\n[1]"],
  ["findmnt -n -o TARGET /proc", "/proc\n[0]"],
  ["findmnt -n -o FSTYPE /proc", "proc\n[0]"],
  ["findmnt -n -o SOURCE,TARGET /proc", "proc   /proc\n[0]"],
  ["findmnt -nr -o TARGET /proc", "/proc\n[0]"],
  ["findmnt -n -o TARGET,FSROOT /proc", "/proc  /\n[0]"],
  ["findmnt -P -o TARGET,FSTYPE -t proc", "TARGET=\"/proc\" FSTYPE=\"proc\"\n[0]"],
  ["findmnt -J -l -o TARGET /proc", "{\n   \"filesystems\": [\n      {\n         \"target\": \"/proc\"\n      }\n   ]\n}\n[0]"],
  ["findmnt -l -o TARGET,SOURCE -t proc,sysfs", "TARGET SOURCE\n/proc  proc\n/sys   sysfs\n[0]"],
  ["findmnt -o TARGET,SOURCE /proc", "TARGET SOURCE\n/proc  proc\n[0]"],
  ["findmnt -o +FSROOT -o TARGET,FSROOT /proc", "TARGET FSROOT\n/proc  /\n[0]"],
  ["findmnt -T /proc/self -n -o TARGET", "/proc\n[0]"],
  ["findmnt -S proc -n -o TARGET", "/proc\n[0]"],
  ["findmnt -M /sys -n -o TARGET", "/sys\n[0]"],
  ["findmnt -f -t proc,sysfs -n -o TARGET", "/proc\n[0]"],
  ["findmnt -t proc,sysfs -n -o TARGET", "/proc\n/sys\n[0]"],
  ["findmnt -o TARGET,TARGET /proc", "TARGET TARGET\n/proc  /proc\n[0]"],
  ["findmnt -r -o TARGET,SOURCE -t proc", "TARGET SOURCE\n/proc proc\n[0]"]
];

describe('findmnt options, columns, filters and statuses against the real binary', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`cd /tmp/ff; ${command} 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
