/*
 * fallocate took only -l and -o: -n -z -p -c -i -d -x -v -V -h were refused as unrecognised options, a missing filename was reported after a missing length,
 * a bad length quoted its text where util-linux does not, the file was always created and always grown, and nothing could punch, zero, collapse or insert
 * a range. runFallocate now follows util-linux fallocate.c: getopt grammar with the 'Try' line, 'no filename specified' before 'no length argument
 * specified', 'invalid length / offset value specified' at option time (a zero or negative length is invalid), 'unexpected number of arguments', the
 * mutual-exclusion messages, creation only in the plain / -x modes ('cannot open X: No such file or directory' otherwise), -n / -p keeping the size,
 * -z zeroing (growing unless -n), -c and -i needing block-aligned ranges ('Invalid argument' otherwise; -i refuses keep-size mode), -d converting the
 * zero blocks, and the -v wording per mode ('allocated', 'hole created', 'zeroed', 'inserted', 'removed', 'converted to sparse holes').
 *
 * Every expected string was produced by the real fallocate of the dev container (util-linux 2.39.3, version rewritten to 2.37.2) on a 2 MiB file of
 * zeros made by the same command line on both sides; block counts are not compared (they belong to the dev container's filesystem).
 *
 * A 1 TiB sparse file is not compared: the simulated filesystem refuses it for lack of space where the dev container creates it sparse.
 * Measured against the commit before (worktree): see the commit message; the echo witness line passes either way and proves the lab.
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

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["echo witness", "witness\n[0]"],
  ["fallocate -l 1M", "fallocate: no filename specified\n[1]"],
  ["fallocate", "fallocate: no filename specified\n[1]"],
  ["fallocate -x", "fallocate: no filename specified\n[1]"],
  ["fallocate -l 1X fz", "fallocate: invalid length value specified\n[1]"],
  ["fallocate -l 0 fz", "fallocate: invalid length value specified\n[1]"],
  ["fallocate -l -5 fz", "fallocate: invalid length value specified\n[1]"],
  ["fallocate -o 1X -l 1 fz", "fallocate: invalid offset value specified\n[1]"],
  ["fallocate -o -1 -l 10 fz", "fallocate: invalid offset value specified\n[1]"],
  ["fallocate -o 5 fz", "fallocate: no length argument specified\n[1]"],
  ["fallocate -l 1M a b", "fallocate: unexpected number of arguments\n[1]"],
  ["fallocate -nosuch", "fallocate: no filename specified\n[1]"],
  ["fallocate --nosuch", "fallocate: unrecognized option '--nosuch'\nTry 'fallocate --help' for more information.\n[1]"],
  ["fallocate -l", "fallocate: option requires an argument -- 'l'\nTry 'fallocate --help' for more information.\n[1]"],
  ["fallocate -V | sed 's/2.39.3/2.37.2/'", "fallocate from util-linux 2.37.2\n[0]"],
  ["fallocate -n -c -l 1 fz", "fallocate: mutually exclusive arguments: --collapse-range --keep-size\n[1]"],
  ["fallocate -p -z -l 1 fz", "fallocate: mutually exclusive arguments: --collapse-range --dig-holes --punch-hole --zero-range\n[1]"],
  ["fallocate -p -c -l 1 fz", "fallocate: mutually exclusive arguments: --collapse-range --dig-holes --punch-hole --zero-range\n[1]"],
  ["fallocate -d -c fz", "fallocate: mutually exclusive arguments: --collapse-range --dig-holes --punch-hole --zero-range\n[1]"],
  ["fallocate -x -z -l 1 fz", "fallocate: mutually exclusive arguments: --posix --collapse-range --dig-holes --insert-range --keep-size --punch-hole --zero-range\n[1]"],
  ["fallocate -n -l 1M new1; echo $?; ls new1", "fallocate: cannot open new1: No such file or directory\n1\nls: cannot access 'new1': No such file or directory\n[2]"],
  ["fallocate -z -l 1M new2; echo $?; ls new2", "fallocate: cannot open new2: No such file or directory\n1\nls: cannot access 'new2': No such file or directory\n[2]"],
  ["fallocate -d new3; echo $?", "fallocate: cannot open new3: No such file or directory\n1\n[0]"],
  ["fallocate -l 1M /nosuchdir/x", "fallocate: cannot open /nosuchdir/x: No such file or directory\n[1]"],
  ["fallocate -l 1 .", "fallocate: cannot open .: Is a directory\n[1]"],
  ["fallocate -v -l 1M new4; stat -c %s new4", "new4: 1 MiB (1048576 bytes) allocated.\n1048576\n[0]"],
  ["fallocate -v -l 1MiB new5", "new5: 1 MiB (1048576 bytes) allocated.\n[0]"],
  ["fallocate -v -l 1.5M new6", "new6: 1.5 MiB (1572864 bytes) allocated.\n[0]"],
  ["fallocate -v -l 1MB new7", "new7: 976.6 KiB (1000000 bytes) allocated.\n[0]"],
  ["fallocate -v -l 10 new8; stat -c %s new8", "new8: 10 B (10 bytes) allocated.\n10\n[0]"],
  ["fallocate -v -l 1k new9; stat -c %s new9", "new9: 1 KiB (1024 bytes) allocated.\n1024\n[0]"],
  ["fallocate -o 5 -l 10 new10; stat -c %s new10", "15\n[0]"],
  ["fallocate -l 1M -l 2M new11; stat -c %s new11", "2097152\n[0]"],
  ["fallocate -v -p -l 1M fz; stat -c %s fz", "fz: 1 MiB (1048576 bytes) hole created.\n2097152\n[0]"],
  ["fallocate -v -n -l 4M fz; stat -c %s fz", "fz: 4 MiB (4194304 bytes) allocated.\n2097152\n[0]"],
  ["fallocate -v -z -l 1M fz; stat -c %s fz", "fz: 1 MiB (1048576 bytes) zeroed.\n2097152\n[0]"],
  ["fallocate -n -z -l 1 fz; stat -c %s fz", "2097152\n[0]"],
  ["fallocate -z -o 1M -l 2M fz; stat -c %s fz", "3145728\n[0]"],
  ["fallocate -v -i -o 0 -l 1M fz; stat -c %s fz", "fz: 1 MiB (1048576 bytes) inserted.\n3145728\n[0]"],
  ["fallocate -i -n -l 1 fz", "fallocate: fallocate failed: keep size mode is unsupported\n[1]"],
  ["fallocate -i -c -l 1 fz", "fallocate: fallocate failed: Operation not supported\n[1]"],
  ["fallocate -i -o 1 -l 4096 fz", "fallocate: fallocate failed: Invalid argument\n[1]"],
  ["fallocate -c -l 1 fz", "fallocate: fallocate failed: Invalid argument\n[1]"],
  ["fallocate -c -o 0 -l 4096 fz; stat -c %s fz", "2093056\n[0]"],
  ["fallocate -c -o 0 -l 4M fz", "fallocate: fallocate failed: Invalid argument\n[1]"],
  ["fallocate -c -o 0 fz", "fallocate: no length argument specified\n[1]"],
  ["fallocate -v -x -l 8K fz; stat -c %s fz", "fz: 8 KiB (8192 bytes) allocated.\n2097152\n[0]"],
  ["fallocate -x -n -l 1 fz; stat -c %s fz", "2097152\n[0]"],
  ["fallocate -v -d fz", "fz: 2 MiB (2097152 bytes) converted to sparse holes.\n[0]"]
];

describe('fallocate grammar, modes, sizes and statuses against the real binary', () => {
  it.each(CASES)('%s', async (command, expected) => {
    const machine = await lab();
    const answer = await machine.executor.runAsUser('root', () => machine.executeCommand(`rm -rf /tmp/fzd; mkdir /tmp/fzd; cd /tmp/fzd; head -c 2097152 /dev/zero > fz; { ${command}; } 2>&1; echo "[$?]"`));
    expect(normalise(answer)).toBe(expected);
  });
});
