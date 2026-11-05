/*
 * df read its line by hand: -B and --block-size were accepted and ignored, long options answered 'invalid option -- nosuch', --output, --total,
 * --sync, -v, --help and --version did not exist, every error exited 0, a file argument printed the argument as the mount point, and a
 * file system with no blocks was hidden by a tmpfs special case. coreutils/DfCommand.ts is a port of coreutils 9.4 df.c over the simulated
 * mount table (the data stays the simulator's own): the getopt table with abbreviations, -B/--block-size parsing (bare unit keeps its suffix in
 * the cells, digits do not; invalid / invalid suffix / too large), -h and -H (ceiling to one decimal under 10), -k -m -P -T -i -a -l -t -x -F, the
 * header names (Size/Avail, Capacity, 1K-blocks computed from the unit, 1MB-blocks...), --output=FIELDS with its unknown / duplicate / mutually
 * exclusive diagnostics, --total, column widths from the content with the minimum widths of the field table, exit status 1 on any error, and
 * 'no file systems processed'.
 *
 * Every expected string was produced by the real df of coreutils 9.4 of the dev container, with runs of spaces squeezed on both sides because the
 * column widths depend on the host's disk sizes; the version and year are rewritten to the simulated 8.32 / 2020. Values (sizes, usage) depend on
 * the host and are never pinned.
 *
 * Measured against the commit before (worktree): 72 of 85 cases fall. The 13 that pass either way are the headers and errors the old code already produced (-h, -H, -i-less forms, nosuch
 * file, "-t nosuch") and double as witnesses of the lab.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/ +/g, ' ').replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["df nosuch", "df: nosuch: No such file or directory\n[1]"],
  ["df -h nosuch", "df: nosuch: No such file or directory\n[1]"],
  ["df -T / | head -1", "Filesystem Type 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -i / | head -1", "Filesystem Inodes IUsed IFree IUse% Mounted on\n[0]"],
  ["df -k / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -m / | head -1", "Filesystem 1M-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B1 / | head -1", "Filesystem 1B-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BM / | head -1", "Filesystem 1M-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BG / | head -1", "Filesystem 1G-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B x /", "df: invalid -B argument 'x'\n[1]"],
  ["df -B 0 /", "df: invalid -B argument '0'\n[1]"],
  ["df --block-size=K / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --block-size=x /", "df: invalid --block-size argument 'x'\n[1]"],
  ["df -P / | head -1", "Filesystem 1024-blocks Used Available Capacity Mounted on\n[0]"],
  ["df --output=source,target / | head -1", "Filesystem Mounted on\n[0]"],
  ["df --output=nosuch /", "df: option --output: field 'nosuch' unknown\nTry 'df --help' for more information.\n[1]"],
  ["df --output=source,source /", "df: option --output: field 'source' used more than once\nTry 'df --help' for more information.\n[1]"],
  ["df --output / | head -1", "Filesystem Type Inodes IUsed IFree IUse% 1K-blocks Used Avail Use% File Mounted on\n[0]"],
  ["df -H / | head -1", "Filesystem Size Used Avail Use% Mounted on\n[0]"],
  ["df -h / | head -1", "Filesystem Size Used Avail Use% Mounted on\n[0]"],
  ["df --sync / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --no-sync / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -t ext4 -x ext4 / 2>&1; echo $?", "df: file system type 'ext4' both selected and excluded\n1\n[0]"],
  ["df -v / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --version | head -1", "df (GNU coreutils) 8.32\n[0]"],
  ["df --help | head -2", "Usage: df [OPTION]... [FILE]...\nShow information about the file system on which each FILE resides,\n[0]"],
  ["df -hk / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -kh / | head -1", "Filesystem Size Used Avail Use% Mounted on\n[0]"],
  ["df -h -B1 / | head -1", "Filesystem 1B-blocks Used Available Use% Mounted on\n[0]"],
  ["df -i -h / | head -1", "Filesystem Inodes IUsed IFree IUse% Mounted on\n[0]"],
  ["df -P -T / | head -1", "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n[0]"],
  ["df -P -h / | head -1", "Filesystem Size Used Avail Use% Mounted on\n[0]"],
  ["df -iP / | head -1", "Filesystem Inodes IUsed IFree IUse% Mounted on\n[0]"],
  ["df -B 1K / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B1M / | head -1", "Filesystem 1M-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B 3 / | head -1", "Filesystem 3B-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B 5000 / | head -1", "Filesystem 5kB-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BKB / | head -1", "Filesystem 1kB-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BkB / | head -1", "Filesystem 1kB-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BKiB / | head -1", "Filesystem 1KiB-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B1KiB / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -P -BM / | head -1", "Filesystem 1048576-blocks Used Available Capacity Mounted on\n[0]"],
  ["df -B 0x10 / | head -1", "Filesystem 16B-blocks Used Available Use% Mounted on\n[0]"],
  ["df -BB /", "df: invalid -B argument 'B'\n[1]"],
  ["df -B 1B /", "df: invalid suffix in -B argument '1B'\n[1]"],
  ["df -B 1e3 /", "df: invalid suffix in -B argument '1e3'\n[1]"],
  ["df -B -1 /", "df: invalid -B argument '-1'\n[1]"],
  ["df -B '' /", "df: invalid -B argument ''\n[1]"],
  ["df -B 1Z /", "df: -B argument '1Z' too large\n[1]"],
  ["df -BE / | head -1", "Filesystem 1E-blocks Used Available Use% Mounted on\n[0]"],
  ["df -B2M / | head -1", "Filesystem 2M-blocks Used Available Use% Mounted on\n[0]"],
  ["df --output=file,target . | head -1", "File Mounted on\n[0]"],
  ["df --output=size,pcent -h / | head -1", " Size Use%\n[0]"],
  ["df -i --output /", "df: options -i and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df -T --output /", "df: options -T and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df -P --output /", "df: options -P and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df --output -i /", "df: options -i and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df --output -T /", "df: options -T and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df --output -P /", "df: options -P and --output are mutually exclusive\nTry 'df --help' for more information.\n[1]"],
  ["df -a -T / | head -1", "Filesystem Type 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --total / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --total -T / | head -1", "Filesystem Type 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -l / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -F ext4 / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -- / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df / --total -T | head -1", "Filesystem Type 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df -ihT / | head -1", "Filesystem Type Inodes IUsed IFree IUse% Mounted on\n[0]"],
  ["df --output=target,source / | head -1", "Mounted on Filesystem\n[0]"],
  ["df --output=avail,used,size / | head -1", " Avail Used 1K-blocks\n[0]"],
  ["df --output=pcent / | head -1", "Use%\n[0]"],
  ["df --out=pcent / | head -1", "Use%\n[0]"],
  ["df --blo=K / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df --inod / | head -1", "Filesystem Inodes IUsed IFree IUse% Mounted on\n[0]"],
  ["df --si / | head -1", "Filesystem Size Used Avail Use% Mounted on\n[0]"],
  ["df -x", "df: option requires an argument -- 'x'\nTry 'df --help' for more information.\n[1]"],
  ["df -t", "df: option requires an argument -- 't'\nTry 'df --help' for more information.\n[1]"],
  ["df --type", "df: option '--type' requires an argument\nTry 'df --help' for more information.\n[1]"],
  ["df --exclude-type", "df: option '--exclude-type' requires an argument\nTry 'df --help' for more information.\n[1]"],
  ["df -t nosuch /", "df: no file systems processed\n[1]"],
  ["df -t nosuch", "df: no file systems processed\n[1]"],
  ["df -x nosuch / | head -1", "Filesystem 1K-blocks Used Available Use% Mounted on\n[0]"],
  ["df / / | wc -l", "3\n[0]"],
  ["df --total / / | tail -1 | cut -c1-5", "total\n[0]"],
  ["df -h / | awk 'NR==1{print NF}'", "7\n[0]"],
  ["df --output=source,fstype,target / | awk 'NR==1{print NF}'", "4\n[0]"],
];

describe('df against the real df', () => {
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
