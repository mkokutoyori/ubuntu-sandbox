/*
 * lsblk took -n, -x, -P and any valued option badly: -n and -x were refused as invalid, a device operand was ignored (the full table came back), a missing
 * block device answered the table instead of '<dev>: not a block device' with status 32, an unknown column said 'invalid column name' where util-linux says
 * 'unknown column: X' (and appends the 'Try' line for -x), the getopt errors lacked the 'Try' line and -V carried the wrong version. cmdLsblk now reads the
 * util-linux option set through the shared getopt reader: -n drops the header, -x sorts (SIZE numerically) as a list, -P prints pairs, -r escapes spaces
 * and prints a header, -e / -I filter on the major number, an operand selects its device and a bad one exits 32 (64 when others were valid).
 *
 * The grammar and status cases carry the strings produced by the real lsblk of the dev container (util-linux 2.39.3, version rewritten to 2.37.2); the cases
 * that read device data carry the simulated machine's own disk (sda, 50G, sda1 48G) in the layout the real one prints for the same options, because the
 * dev container's disks (vda, zram0...) differ from the simulated ones.
 *
 * Measured against the commit before (worktree): see the commit message; the 'echo witness' line passes either way and proves the lab.
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
  ["lsblk -x", "lsblk: option requires an argument -- 'x'\nTry 'lsblk --help' for more information.\n[1]"],
  ["lsblk --nosuch", "lsblk: unrecognized option '--nosuch'\nTry 'lsblk --help' for more information.\n[1]"],
  ["lsblk -o NOSUCH", "lsblk: unknown column: NOSUCH\n[1]"],
  ["lsblk -x NOSUCH", "lsblk: unknown column: NOSUCH\nTry 'lsblk --help' for more information.\n[1]"],
  ["lsblk -V", "lsblk from util-linux 2.37.2\n[0]"],
  ["lsblk /dev/nosuch", "lsblk: /dev/nosuch: not a block device\n[32]"],
  ["lsblk nosuch", "lsblk: nosuch: not a block device\n[32]"],
  ["lsblk /etc/passwd", "lsblk: /etc/passwd: not a block device\n[32]"],
  ["lsblk -dn -o NAME,SIZE /dev/sda", "sda  50G\n[0]"],
  ["lsblk -n -o NAME /dev/sda1", "sda1\n[0]"],
  ["lsblk -b -n -o SIZE /dev/sda1", "51539607552\n[0]"],
  ["lsblk -rn -o NAME,SIZE /dev/sda1", "sda1 48G\n[0]"],
  ["lsblk -P -o NAME,SIZE /dev/sda1", "NAME=\"sda1\" SIZE=\"48G\"\n[0]"],
  ["lsblk -x SIZE -o NAME,SIZE | head -1", "NAME  SIZE\n[0]"],
  ["lsblk -x SIZE -n -o NAME | head -1", "loop0\n[0]"],
  ["lsblk -o NAME | head -1", "NAME\n[0]"],
  ["lsblk -o name,size /dev/sda1", "NAME SIZE\nsda1 48G\n[0]"]
];


describe('lsblk grammar, filters, formats and statuses against the real binary', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`cd /tmp/ff; ${command} 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
