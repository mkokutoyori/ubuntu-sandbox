/*
 * blkid refused every dash word it did not know with an invented message ('unrecognized option' for -o, -s, -t, -L, -U, -x), ignored -o, -s, -t, -L and -U,
 * printed 'blkid: error: <dev>: No such file or directory' for a device the real one ignores in silence (status 2), could only read the hardware
 * partitions and carried 'util-linux 2.37' without its libblkid tail. cmdBlkid now reads the util-linux option set through the shared getopt reader
 * (the 'invalid option' / 'requires an argument' texts with the 'Try' line, status 1), selects the output with -o full / value / device / export / list /
 * udev ('unsupported output format X', status 4), filters the tags with -s (printed in the canonical LABEL UUID TYPE PARTUUID order whatever the order
 * of the options), the devices with -t NAME=value ('-t needs NAME=value pair', status 4) and -L / -U, answers status 2 when nothing matches, and probes a
 * regular file for the swap signature that mkswap writes, so 'blkid FILE' says LABEL / UUID / TYPE="swap".
 *
 * Every expected string was produced by the real blkid, mkswap and head of the dev container (util-linux 2.39.3) on files of zeros in a scratch directory.
 * The hardware partitions of the two machines differ and are covered by the existing blkid tests; -h and -V are not compared (their texts differ between
 * util-linux 2.37.2 and 2.39.3).
 *
 * Measured against the commit before (worktree): 26 of 27 cases fall; the one that passes either way is 'echo witness', which proves the lab.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

const SETUP = 'swapoff -a >/dev/null 2>&1; rm -rf /tmp/bkd; mkdir /tmp/bkd; cd /tmp/bkd; head -c 4194304 /dev/zero > f; chmod 600 f; mkswap -L lab -U 11111111-2222-3333-4444-555555555555 f >/dev/null; head -c 8192 /dev/zero > plain; head -c 4194304 /dev/zero > nolabel; chmod 600 nolabel; mkswap -U 33333333-4444-5555-6666-777777777777 nolabel >/dev/null';

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo witness", "witness\n[0]"],
  ["blkid /tmp/bkd/f", "/tmp/bkd/f: LABEL=\"lab\" UUID=\"11111111-2222-3333-4444-555555555555\" TYPE=\"swap\"\n[0]"],
  ["blkid -o value /tmp/bkd/f", "lab\n11111111-2222-3333-4444-555555555555\nswap\n[0]"],
  ["blkid -o export /tmp/bkd/f", "DEVNAME=/tmp/bkd/f\nLABEL=lab\nUUID=11111111-2222-3333-4444-555555555555\nTYPE=swap\n[0]"],
  ["blkid -o device /tmp/bkd/f", "/tmp/bkd/f\n[0]"],
  ["blkid -s UUID -o value /tmp/bkd/f", "11111111-2222-3333-4444-555555555555\n[0]"],
  ["blkid -s TYPE -s LABEL /tmp/bkd/f", "/tmp/bkd/f: LABEL=\"lab\" TYPE=\"swap\"\n[0]"],
  ["blkid -t TYPE=swap /tmp/bkd/f", "/tmp/bkd/f: LABEL=\"lab\" UUID=\"11111111-2222-3333-4444-555555555555\" TYPE=\"swap\"\n[0]"],
  ["blkid -t TYPE=ext4 /tmp/bkd/f", "[2]"],
  ["blkid -t LABEL=lab /tmp/bkd/f /tmp/bkd/nolabel", "/tmp/bkd/f: LABEL=\"lab\" UUID=\"11111111-2222-3333-4444-555555555555\" TYPE=\"swap\"\n[0]"],
  ["blkid -o list /tmp/bkd/f", "device     fs_type label    mount point    UUID\n\n/tmp/bkd/f swap    lab      (not mounted)  11111111-2222-3333-4444-555555555555\n[0]"],
  ["blkid -o udev /tmp/bkd/f", "ID_FS_LABEL=lab\nID_FS_LABEL_ENC=lab\nID_FS_UUID=11111111-2222-3333-4444-555555555555\nID_FS_UUID_ENC=11111111-2222-3333-4444-555555555555\nID_FS_TYPE=swap\n[0]"],
  ["blkid -o full /tmp/bkd/nolabel", "/tmp/bkd/nolabel: UUID=\"33333333-4444-5555-6666-777777777777\" TYPE=\"swap\"\n[0]"],
  ["blkid /tmp/bkd/f /tmp/bkd/nolabel", "/tmp/bkd/f: LABEL=\"lab\" UUID=\"11111111-2222-3333-4444-555555555555\" TYPE=\"swap\"\n/tmp/bkd/nolabel: UUID=\"33333333-4444-5555-6666-777777777777\" TYPE=\"swap\"\n[0]"],
  ["blkid /tmp/bkd/plain", "[2]"],
  ["blkid /tmp/bkd/nosuch", "[2]"],
  ["blkid /dev/nosuch", "[2]"],
  ["blkid -o bad /tmp/bkd/f", "blkid: unsupported output format bad\n[4]"],
  ["blkid -t bad /tmp/bkd/f", "blkid: -t needs NAME=value pair\nTry 'blkid --help' for more information.\n[4]"],
  ["blkid -x", "blkid: invalid option -- 'x'\nTry 'blkid --help' for more information.\n[1]"],
  ["blkid --nosuch", "blkid: unrecognized option '--nosuch'\nTry 'blkid --help' for more information.\n[1]"],
  ["blkid -s", "blkid: option requires an argument -- 's'\nTry 'blkid --help' for more information.\n[1]"],
  ["blkid -o", "blkid: option requires an argument -- 'o'\nTry 'blkid --help' for more information.\n[1]"],
  ["blkid -L nosuchlabel", "[2]"],
  ["blkid -U 00000000-0000-0000-0000-000000000000", "[2]"],
  ["blkid -s LABEL -o value /tmp/bkd/nolabel", "[0]"],
  ["blkid -o export /tmp/bkd/f /tmp/bkd/nolabel", "DEVNAME=/tmp/bkd/f\nLABEL=lab\nUUID=11111111-2222-3333-4444-555555555555\nTYPE=swap\n\nDEVNAME=/tmp/bkd/nolabel\nUUID=33333333-4444-5555-6666-777777777777\nTYPE=swap\n[0]"]
];

describe('blkid grammar, outputs, filters and swap-file probing against the real binary', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`${SETUP}; { ${command}; } 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
