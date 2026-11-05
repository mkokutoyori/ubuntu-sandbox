/*
 * swapon and swapoff only listed the one built-in /swapfile and refused every activation ('swap areas cannot be activated on this system'), swapon
 * ignored every option (-p, -e, -v, -a, --show=COLUMNS, --raw, --bytes, bad options), swapoff answered 255 and mkswap did not exist. MemoryProfile now
 * keeps a list of swap areas (free, /proc/meminfo, vmstat, /proc/swaps, swapon --show and swapon -s all read it), mkswap writes a swap signature page
 * with a UUID and label into a file, swapon reads it back ('read swap header failed' without one, 'Device or resource busy' when already active,
 * the 'insecure permissions' warning, priorities -2, -3... or -p N, -v, -e, -a from /etc/fstab, --show with its columns / --noheadings / --raw / --bytes)
 * and swapoff removes the area ('swapoff failed: Invalid argument / No such file or directory', status 4, 'bad usage' status 16, -v, -a).
 *
 * Every expected string was produced by the real mkswap / swapon / swapoff of the dev container (util-linux 2.39.3, version rewritten to 2.37.2) in a
 * scratch directory, every swap deactivated afterwards; UUIDs are masked as <uuid>. The simulated machine starts with its 2 GiB /swapfile active, so each
 * case begins with 'swapoff -a'. The real machine's free-form /proc/swaps size is the signature-page-less size in KiB (4092 for a 4 MiB file), as here.
 *
 * Measured against the commit before (worktree): see the commit message; the 'echo witness' line passes either way and proves the lab.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const normalise = (text: string): string => text
  .replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

const SETUP = 'swapoff -a >/dev/null 2>&1; rm -rf /tmp/swd; mkdir /tmp/swd; cd /tmp/swd; for f in s1 s2 s3; do dd if=/dev/zero of=$f bs=1M count=4 2>/dev/null; chmod 600 $f; done';

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo witness", "witness\n[0]"],
  ["mkswap s1", "Setting up swapspace version 1, size = 4 MiB (4190208 bytes)\nno label, UUID=<uuid>\n[0]"],
  ["mkswap -L lbl -U 11111111-2222-3333-4444-555555555555 s2", "Setting up swapspace version 1, size = 4 MiB (4190208 bytes)\nLABEL=lbl, UUID=<uuid>\n[0]"],
  ["mkswap", "mkswap: error: Nowhere to set up swap on?\nTry 'mkswap --help' for more information.\n[1]"],
  ["mkswap nosuch", "mkswap: cannot open nosuch: No such file or directory\n[1]"],
  ["mkswap -x", "mkswap: invalid option -- 'x'\nTry 'mkswap --help' for more information.\n[1]"],
  ["mkswap /etc/passwd", "mkswap: error: swap area needs to be at least 40 KiB\n[1]"],
  ["mkswap -V | sed 's/2.39.3/2.37.2/'", "mkswap from util-linux 2.37.2\n[0]"],
  ["mkswap -U bad s1", "mkswap: error: parsing UUID failed\n[1]"],
  ["chmod 644 s1; mkswap s1", "mkswap: s1: insecure permissions 0644, fix with: chmod 0600 s1\nSetting up swapspace version 1, size = 4 MiB (4190208 bytes)\nno label, UUID=<uuid>\n[0]"],
  ["mkswap .", "mkswap: cannot determine size of .: Block device required\n[1]"],
  ["mkswap s1 8", "mkswap: error: swap area needs to be at least 40 KiB\n[1]"],
  ["swapon -x", "swapon: invalid option -- 'x'\nTry 'swapon --help' for more information.\n[1]"],
  ["swapon --nosuch", "swapon: unrecognized option '--nosuch'\nTry 'swapon --help' for more information.\n[1]"],
  ["swapon -p", "swapon: option requires an argument -- 'p'\nTry 'swapon --help' for more information.\n[1]"],
  ["swapon -p x s1", "swapon: failed to parse priority: 'x'\n[1]"],
  ["swapon --discard=bad s1", "swapon: unsupported discard policy: bad\n[1]"],
  ["swapon nosuch", "swapon: cannot open nosuch: No such file or directory\n[255]"],
  ["swapon -e nosuch", "swapon: bad usage\nTry 'swapon --help' for more information.\n[1]"],
  ["swapon s1", "swapon: /tmp/swd/s1: read swap header failed\n[255]"],
  ["swapon -U x", "swapon: cannot find the device for x\n[255]"],
  ["swapon -V | sed 's/2.39.3/2.37.2/'", "swapon from util-linux 2.37.2\n[0]"],
  ["swapon --show", "[0]"],
  ["swapon -s", "[0]"],
  ["swapon", "[0]"],
  ["swapon --show=NOSUCH", "swapon: unknown column: NOSUCH\n[1]"],
  ["mkswap s1; swapon s1; echo $?; swapon s1; echo $?", "Setting up swapspace version 1, size = 4 MiB (4190208 bytes)\nno label, UUID=<uuid>\n0\nswapon: /tmp/swd/s1: swapon failed: Device or resource busy\n255\n[0]"],
  ["mkswap s1 >/dev/null; swapon -v s1", "swapon: /tmp/swd/s1: found signature [pagesize=4096, signature=swap]\nswapon: /tmp/swd/s1: pagesize=4096, swapsize=4194304, devsize=4194304\nswapon /tmp/swd/s1\n[0]"],
  ["mkswap s1 >/dev/null; chmod 644 s1; swapon s1; echo $?", "swapon: /tmp/swd/s1: insecure permissions 0644, 0600 suggested.\n0\n[0]"],
  ["chmod 644 s3; swapon s3; echo $?", "swapon: /tmp/swd/s3: insecure permissions 0644, 0600 suggested.\nswapon: /tmp/swd/s3: read swap header failed\n255\n[0]"],
  ["swapon .; echo $?", "swapon: /tmp/swd: insecure permissions 0755, 0600 suggested.\nswapon: /tmp/swd: read swap header failed\n255\n[0]"],
  ["mkswap s1 >/dev/null; mkswap -L two s2 >/dev/null; swapon s1; swapon -p 5 s2; swapon --show; swapon --show=NAME,SIZE,LABEL; swapon --show --noheadings --raw; swapon --show --bytes; swapon -s; cat /proc/swaps; swapon --show=PRIO,NAME --noheadings", "NAME        TYPE SIZE USED PRIO\n/tmp/swd/s1 file   4M   0B   -2\n/tmp/swd/s2 file   4M   0B    5\nNAME        SIZE LABEL\n/tmp/swd/s1   4M \n/tmp/swd/s2   4M two\n/tmp/swd/s1 file 4M 0B -2\n/tmp/swd/s2 file 4M 0B 5\nNAME        TYPE    SIZE USED PRIO\n/tmp/swd/s1 file 4190208    0   -2\n/tmp/swd/s2 file 4190208    0    5\nFilename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/tmp/swd/s1                             file\t\t4092\t\t0\t\t-2\n/tmp/swd/s2                             file\t\t4092\t\t0\t\t5\nFilename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/tmp/swd/s1                             file\t\t4092\t\t0\t\t-2\n/tmp/swd/s2                             file\t\t4092\t\t0\t\t5\n  -2 /tmp/swd/s1\n   5 /tmp/swd/s2\n[0]"],
  ["mkswap s1 >/dev/null; mkswap s2 >/dev/null; swapon s1 s2; swapon --show --noheadings; swapoff s1; swapon --show --noheadings", "/tmp/swd/s1 file   4M   0B   -2\n/tmp/swd/s2 file   4M   0B   -3\n/tmp/swd/s2 file   4M   0B   -2\n[0]"],
  ["swapoff", "swapoff: bad usage\nTry 'swapoff --help' for more information.\n[16]"],
  ["swapoff -x", "swapoff: invalid option -- 'x'\nTry 'swapoff --help' for more information.\n[16]"],
  ["swapoff nosuch; echo $?", "swapoff: nosuch: swapoff failed: No such file or directory\n4\n[0]"],
  ["swapoff s1; echo $?", "swapoff: s1: swapoff failed: Invalid argument\n4\n[0]"],
  ["mkswap s1 >/dev/null; swapon s1; swapoff -v s1; swapon --show; echo $?", "swapoff s1\n0\n[0]"],
  ["mkswap s1 >/dev/null; mkswap s2 >/dev/null; swapon s1 s2; swapoff -v -a; echo $?; swapon --show", "swapoff /tmp/swd/s2\nswapoff /tmp/swd/s1\n0\n[0]"],
  ["swapoff -a; echo $?", "0\n[0]"],
  ["swapoff -V | sed 's/2.39.3/2.37.2/'", "swapoff from util-linux 2.37.2\n[0]"],
  ["mkswap s1 >/dev/null; swapon s1; swapon -e s1; echo $?; swapoff s1", "swapon: bad usage\nTry 'swapon --help' for more information.\n1\n[0]"]
];

describe('mkswap, swapon and swapoff against the real binaries', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`${SETUP}; { ${command}; } 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
