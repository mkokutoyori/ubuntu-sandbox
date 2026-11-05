/*
/*
 * ls --block-size was accepted by the option guard and ignored. It now scales the total line, the -s column
 * and the -l size column with the du grammar (BlockSize.ts, shared with du): a bare unit letter adds its
 * suffix, a count does not, KB and MB are powers of 1000, KiB of 1024, sizes round up, -h and --si replace
 * it and it replaces them (last wins), -k does not undo an explicit block size, and a bad value is refused
 * with exit status 2 (invalid suffix in the message when digits are followed by other characters).
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 as root (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). The BLOCK_SIZE and LS_BLOCK_SIZE environment variables are not modelled (TODO.md).
 *
 * Measured against the commit before (worktree): 83 of 98 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "printf 'x%.0s' $(seq 1 5000) > big; : > e0; printf 'y' > one; head -c 1500000 /dev/zero > huge; mkdir -p sub";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ROOT:ls -l --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n-rw-r--r-- 1 root root    5K big\n-rw-r--r-- 1 root root    0K e0\n-rw-r--r-- 1 root root 1465K huge\n-rw-r--r-- 1 root root    1K one\ndrwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ls --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n   8K -rw-r--r-- 1 root root    5K big\n   0K -rw-r--r-- 1 root root    0K e0\n1468K -rw-r--r-- 1 root root 1465K huge\n   4K -rw-r--r-- 1 root root    1K one\n   4K drwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -1s --block-size=K", "total 1484K\n   8K big\n   0K e0\n1468K huge\n   4K one\n   4K sub\n[0]"],
  ["ROOT:ls -l --block-size=1 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1519616\n-rw-r--r-- 1 root root    5000 big\n-rw-r--r-- 1 root root       0 e0\n-rw-r--r-- 1 root root 1500000 huge\n-rw-r--r-- 1 root root       1 one\ndrwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -ls --block-size=1 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1519616\n   8192 -rw-r--r-- 1 root root    5000 big\n      0 -rw-r--r-- 1 root root       0 e0\n1503232 -rw-r--r-- 1 root root 1500000 huge\n   4096 -rw-r--r-- 1 root root       1 one\n   4096 drwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -1s --block-size=1", "total 1519616\n   8192 big\n      0 e0\n1503232 huge\n   4096 one\n   4096 sub\n[0]"],
  ["ROOT:ls -l --block-size=M | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2M\n-rw-r--r-- 1 root root 1M big\n-rw-r--r-- 1 root root 0M e0\n-rw-r--r-- 1 root root 2M huge\n-rw-r--r-- 1 root root 1M one\ndrwxr-xr-x 2 root root 1M sub\n[0]"],
  ["ROOT:ls -ls --block-size=M | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2M\n1M -rw-r--r-- 1 root root 1M big\n0M -rw-r--r-- 1 root root 0M e0\n2M -rw-r--r-- 1 root root 2M huge\n1M -rw-r--r-- 1 root root 1M one\n1M drwxr-xr-x 2 root root 1M sub\n[0]"],
  ["ROOT:ls -1s --block-size=M", "total 2M\n1M big\n0M e0\n2M huge\n1M one\n1M sub\n[0]"],
  ["ROOT:ls -l --block-size=1000 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520\n-rw-r--r-- 1 root root    5 big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 1500 huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root    5 sub\n[0]"],
  ["ROOT:ls -ls --block-size=1000 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520\n   9 -rw-r--r-- 1 root root    5 big\n   0 -rw-r--r-- 1 root root    0 e0\n1504 -rw-r--r-- 1 root root 1500 huge\n   5 -rw-r--r-- 1 root root    1 one\n   5 drwxr-xr-x 2 root root    5 sub\n[0]"],
  ["ROOT:ls -1s --block-size=1000", "total 1520\n   9 big\n   0 e0\n1504 huge\n   5 one\n   5 sub\n[0]"],
  ["ROOT:ls -l --block-size=KB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520kB\n-rw-r--r-- 1 root root    5kB big\n-rw-r--r-- 1 root root    0kB e0\n-rw-r--r-- 1 root root 1500kB huge\n-rw-r--r-- 1 root root    1kB one\ndrwxr-xr-x 2 root root    5kB sub\n[0]"],
  ["ROOT:ls -ls --block-size=KB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520kB\n   9kB -rw-r--r-- 1 root root    5kB big\n   0kB -rw-r--r-- 1 root root    0kB e0\n1504kB -rw-r--r-- 1 root root 1500kB huge\n   5kB -rw-r--r-- 1 root root    1kB one\n   5kB drwxr-xr-x 2 root root    5kB sub\n[0]"],
  ["ROOT:ls -1s --block-size=KB", "total 1520kB\n   9kB big\n   0kB e0\n1504kB huge\n   5kB one\n   5kB sub\n[0]"],
  ["ROOT:ls -l --block-size=KiB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484KiB\n-rw-r--r-- 1 root root    5KiB big\n-rw-r--r-- 1 root root    0KiB e0\n-rw-r--r-- 1 root root 1465KiB huge\n-rw-r--r-- 1 root root    1KiB one\ndrwxr-xr-x 2 root root    4KiB sub\n[0]"],
  ["ROOT:ls -ls --block-size=KiB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484KiB\n   8KiB -rw-r--r-- 1 root root    5KiB big\n   0KiB -rw-r--r-- 1 root root    0KiB e0\n1468KiB -rw-r--r-- 1 root root 1465KiB huge\n   4KiB -rw-r--r-- 1 root root    1KiB one\n   4KiB drwxr-xr-x 2 root root    4KiB sub\n[0]"],
  ["ROOT:ls -1s --block-size=KiB", "total 1484KiB\n   8KiB big\n   0KiB e0\n1468KiB huge\n   4KiB one\n   4KiB sub\n[0]"],
  ["ROOT:ls -l --block-size=1KB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520\n-rw-r--r-- 1 root root    5 big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 1500 huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root    5 sub\n[0]"],
  ["ROOT:ls -ls --block-size=1KB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520\n   9 -rw-r--r-- 1 root root    5 big\n   0 -rw-r--r-- 1 root root    0 e0\n1504 -rw-r--r-- 1 root root 1500 huge\n   5 -rw-r--r-- 1 root root    1 one\n   5 drwxr-xr-x 2 root root    5 sub\n[0]"],
  ["ROOT:ls -1s --block-size=1KB", "total 1520\n   9 big\n   0 e0\n1504 huge\n   5 one\n   5 sub\n[0]"],
  ["ROOT:ls -l --block-size=2K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 742\n-rw-r--r-- 1 root root   3 big\n-rw-r--r-- 1 root root   0 e0\n-rw-r--r-- 1 root root 733 huge\n-rw-r--r-- 1 root root   1 one\ndrwxr-xr-x 2 root root   2 sub\n[0]"],
  ["ROOT:ls -ls --block-size=2K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 742\n  4 -rw-r--r-- 1 root root   3 big\n  0 -rw-r--r-- 1 root root   0 e0\n734 -rw-r--r-- 1 root root 733 huge\n  2 -rw-r--r-- 1 root root   1 one\n  2 drwxr-xr-x 2 root root   2 sub\n[0]"],
  ["ROOT:ls -1s --block-size=2K", "total 742\n  4 big\n  0 e0\n734 huge\n  2 one\n  2 sub\n[0]"],
  ["ROOT:ls -l --block-size=3 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 506539\n-rw-r--r-- 1 root root   1667 big\n-rw-r--r-- 1 root root      0 e0\n-rw-r--r-- 1 root root 500000 huge\n-rw-r--r-- 1 root root      1 one\ndrwxr-xr-x 2 root root   1366 sub\n[0]"],
  ["ROOT:ls -ls --block-size=3 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 506539\n  2731 -rw-r--r-- 1 root root   1667 big\n     0 -rw-r--r-- 1 root root      0 e0\n501078 -rw-r--r-- 1 root root 500000 huge\n  1366 -rw-r--r-- 1 root root      1 one\n  1366 drwxr-xr-x 2 root root   1366 sub\n[0]"],
  ["ROOT:ls -1s --block-size=3", "total 506539\n  2731 big\n     0 e0\n501078 huge\n  1366 one\n  1366 sub\n[0]"],
  ["ROOT:ls -l --block-size=G | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1G\n-rw-r--r-- 1 root root 1G big\n-rw-r--r-- 1 root root 0G e0\n-rw-r--r-- 1 root root 1G huge\n-rw-r--r-- 1 root root 1G one\ndrwxr-xr-x 2 root root 1G sub\n[0]"],
  ["ROOT:ls -ls --block-size=G | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1G\n1G -rw-r--r-- 1 root root 1G big\n0G -rw-r--r-- 1 root root 0G e0\n1G -rw-r--r-- 1 root root 1G huge\n1G -rw-r--r-- 1 root root 1G one\n1G drwxr-xr-x 2 root root 1G sub\n[0]"],
  ["ROOT:ls -1s --block-size=G", "total 1G\n1G big\n0G e0\n1G huge\n1G one\n1G sub\n[0]"],
  ["ROOT:ls -l --block-size=T | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1T\n-rw-r--r-- 1 root root 1T big\n-rw-r--r-- 1 root root 0T e0\n-rw-r--r-- 1 root root 1T huge\n-rw-r--r-- 1 root root 1T one\ndrwxr-xr-x 2 root root 1T sub\n[0]"],
  ["ROOT:ls -ls --block-size=T | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1T\n1T -rw-r--r-- 1 root root 1T big\n0T -rw-r--r-- 1 root root 0T e0\n1T -rw-r--r-- 1 root root 1T huge\n1T -rw-r--r-- 1 root root 1T one\n1T drwxr-xr-x 2 root root 1T sub\n[0]"],
  ["ROOT:ls -1s --block-size=T", "total 1T\n1T big\n0T e0\n1T huge\n1T one\n1T sub\n[0]"],
  ["ROOT:ls -l --block-size=k | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n-rw-r--r-- 1 root root    5K big\n-rw-r--r-- 1 root root    0K e0\n-rw-r--r-- 1 root root 1465K huge\n-rw-r--r-- 1 root root    1K one\ndrwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ls --block-size=k | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n   8K -rw-r--r-- 1 root root    5K big\n   0K -rw-r--r-- 1 root root    0K e0\n1468K -rw-r--r-- 1 root root 1465K huge\n   4K -rw-r--r-- 1 root root    1K one\n   4K drwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -1s --block-size=k", "total 1484K\n   8K big\n   0K e0\n1468K huge\n   4K one\n   4K sub\n[0]"],
  ["ROOT:ls -l --block-size=m | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2M\n-rw-r--r-- 1 root root 1M big\n-rw-r--r-- 1 root root 0M e0\n-rw-r--r-- 1 root root 2M huge\n-rw-r--r-- 1 root root 1M one\ndrwxr-xr-x 2 root root 1M sub\n[0]"],
  ["ROOT:ls -ls --block-size=m | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2M\n1M -rw-r--r-- 1 root root 1M big\n0M -rw-r--r-- 1 root root 0M e0\n2M -rw-r--r-- 1 root root 2M huge\n1M -rw-r--r-- 1 root root 1M one\n1M drwxr-xr-x 2 root root 1M sub\n[0]"],
  ["ROOT:ls -1s --block-size=m", "total 2M\n1M big\n0M e0\n2M huge\n1M one\n1M sub\n[0]"],
  ["ROOT:ls -l --block-size=kB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520kB\n-rw-r--r-- 1 root root    5kB big\n-rw-r--r-- 1 root root    0kB e0\n-rw-r--r-- 1 root root 1500kB huge\n-rw-r--r-- 1 root root    1kB one\ndrwxr-xr-x 2 root root    5kB sub\n[0]"],
  ["ROOT:ls -ls --block-size=kB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1520kB\n   9kB -rw-r--r-- 1 root root    5kB big\n   0kB -rw-r--r-- 1 root root    0kB e0\n1504kB -rw-r--r-- 1 root root 1500kB huge\n   5kB -rw-r--r-- 1 root root    1kB one\n   5kB drwxr-xr-x 2 root root    5kB sub\n[0]"],
  ["ROOT:ls -1s --block-size=kB", "total 1520kB\n   9kB big\n   0kB e0\n1504kB huge\n   5kB one\n   5kB sub\n[0]"],
  ["ROOT:ls -l --block-size=MB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2MB\n-rw-r--r-- 1 root root 1MB big\n-rw-r--r-- 1 root root 0MB e0\n-rw-r--r-- 1 root root 2MB huge\n-rw-r--r-- 1 root root 1MB one\ndrwxr-xr-x 2 root root 1MB sub\n[0]"],
  ["ROOT:ls -ls --block-size=MB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2MB\n1MB -rw-r--r-- 1 root root 1MB big\n0MB -rw-r--r-- 1 root root 0MB e0\n2MB -rw-r--r-- 1 root root 2MB huge\n1MB -rw-r--r-- 1 root root 1MB one\n1MB drwxr-xr-x 2 root root 1MB sub\n[0]"],
  ["ROOT:ls -1s --block-size=MB", "total 2MB\n1MB big\n0MB e0\n2MB huge\n1MB one\n1MB sub\n[0]"],
  ["ROOT:ls -l --block-size=MiB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2MiB\n-rw-r--r-- 1 root root 1MiB big\n-rw-r--r-- 1 root root 0MiB e0\n-rw-r--r-- 1 root root 2MiB huge\n-rw-r--r-- 1 root root 1MiB one\ndrwxr-xr-x 2 root root 1MiB sub\n[0]"],
  ["ROOT:ls -ls --block-size=MiB | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2MiB\n1MiB -rw-r--r-- 1 root root 1MiB big\n0MiB -rw-r--r-- 1 root root 0MiB e0\n2MiB -rw-r--r-- 1 root root 2MiB huge\n1MiB -rw-r--r-- 1 root root 1MiB one\n1MiB drwxr-xr-x 2 root root 1MiB sub\n[0]"],
  ["ROOT:ls -1s --block-size=MiB", "total 2MiB\n1MiB big\n0MiB e0\n2MiB huge\n1MiB one\n1MiB sub\n[0]"],
  ["ROOT:ls -l --block-size=4096 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 371\n-rw-r--r-- 1 root root   2 big\n-rw-r--r-- 1 root root   0 e0\n-rw-r--r-- 1 root root 367 huge\n-rw-r--r-- 1 root root   1 one\ndrwxr-xr-x 2 root root   1 sub\n[0]"],
  ["ROOT:ls -ls --block-size=4096 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 371\n  2 -rw-r--r-- 1 root root   2 big\n  0 -rw-r--r-- 1 root root   0 e0\n367 -rw-r--r-- 1 root root 367 huge\n  1 -rw-r--r-- 1 root root   1 one\n  1 drwxr-xr-x 2 root root   1 sub\n[0]"],
  ["ROOT:ls -1s --block-size=4096", "total 371\n  2 big\n  0 e0\n367 huge\n  1 one\n  1 sub\n[0]"],
  ["ROOT:ls -l --block-size=512 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2968\n-rw-r--r-- 1 root root   10 big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 2930 huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root    8 sub\n[0]"],
  ["ROOT:ls -ls --block-size=512 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2968\n  16 -rw-r--r-- 1 root root   10 big\n   0 -rw-r--r-- 1 root root    0 e0\n2936 -rw-r--r-- 1 root root 2930 huge\n   8 -rw-r--r-- 1 root root    1 one\n   8 drwxr-xr-x 2 root root    8 sub\n[0]"],
  ["ROOT:ls -1s --block-size=512", "total 2968\n  16 big\n   0 e0\n2936 huge\n   8 one\n   8 sub\n[0]"],
  ["ROOT:ls -l --block-size=1M | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2\n-rw-r--r-- 1 root root 1 big\n-rw-r--r-- 1 root root 0 e0\n-rw-r--r-- 1 root root 2 huge\n-rw-r--r-- 1 root root 1 one\ndrwxr-xr-x 2 root root 1 sub\n[0]"],
  ["ROOT:ls -ls --block-size=1M | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2\n1 -rw-r--r-- 1 root root 1 big\n0 -rw-r--r-- 1 root root 0 e0\n2 -rw-r--r-- 1 root root 2 huge\n1 -rw-r--r-- 1 root root 1 one\n1 drwxr-xr-x 2 root root 1 sub\n[0]"],
  ["ROOT:ls -1s --block-size=1M", "total 2\n1 big\n0 e0\n2 huge\n1 one\n1 sub\n[0]"],
  ["ROOT:ls -l --block-size=12345 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 124\n-rw-r--r-- 1 root root   1 big\n-rw-r--r-- 1 root root   0 e0\n-rw-r--r-- 1 root root 122 huge\n-rw-r--r-- 1 root root   1 one\ndrwxr-xr-x 2 root root   1 sub\n[0]"],
  ["ROOT:ls -ls --block-size=12345 | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 124\n  1 -rw-r--r-- 1 root root   1 big\n  0 -rw-r--r-- 1 root root   0 e0\n122 -rw-r--r-- 1 root root 122 huge\n  1 -rw-r--r-- 1 root root   1 one\n  1 drwxr-xr-x 2 root root   1 sub\n[0]"],
  ["ROOT:ls -1s --block-size=12345", "total 124\n  1 big\n  0 e0\n122 huge\n  1 one\n  1 sub\n[0]"],
  ["ROOT:ls -l --block-size=0", "ls: invalid --block-size argument '0'\n[2]"],
  ["ROOT:ls -1s --block-size=0", "ls: invalid --block-size argument '0'\n[2]"],
  ["ROOT:ls -l --block-size=x", "ls: invalid --block-size argument 'x'\n[2]"],
  ["ROOT:ls -1s --block-size=x", "ls: invalid --block-size argument 'x'\n[2]"],
  ["ROOT:ls -l --block-size=", "ls: invalid --block-size argument ''\n[2]"],
  ["ROOT:ls -1s --block-size=", "ls: invalid --block-size argument ''\n[2]"],
  ["ROOT:ls -l --block-size=-1", "ls: invalid --block-size argument '-1'\n[2]"],
  ["ROOT:ls -1s --block-size=-1", "ls: invalid --block-size argument '-1'\n[2]"],
  ["ROOT:ls -l --block-size=1.5K", "ls: invalid suffix in --block-size argument '1.5K'\n[2]"],
  ["ROOT:ls -1s --block-size=1.5K", "ls: invalid suffix in --block-size argument '1.5K'\n[2]"],
  ["ROOT:ls -l --block-size=1e3", "ls: invalid suffix in --block-size argument '1e3'\n[2]"],
  ["ROOT:ls -1s --block-size=1e3", "ls: invalid suffix in --block-size argument '1e3'\n[2]"],
  ["ROOT:ls -l | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484\n-rw-r--r-- 1 root root    5000 big\n-rw-r--r-- 1 root root       0 e0\n-rw-r--r-- 1 root root 1500000 huge\n-rw-r--r-- 1 root root       1 one\ndrwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -1s", "total 1484\n   8 big\n   0 e0\n1468 huge\n   4 one\n   4 sub\n[0]"],
  ["ROOT:ls -1sk", "total 1484\n   8 big\n   0 e0\n1468 huge\n   4 one\n   4 sub\n[0]"],
  ["ROOT:ls -l -k | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484\n-rw-r--r-- 1 root root    5000 big\n-rw-r--r-- 1 root root       0 e0\n-rw-r--r-- 1 root root 1500000 huge\n-rw-r--r-- 1 root root       1 one\ndrwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -ls -k | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484\n   8 -rw-r--r-- 1 root root    5000 big\n   0 -rw-r--r-- 1 root root       0 e0\n1468 -rw-r--r-- 1 root root 1500000 huge\n   4 -rw-r--r-- 1 root root       1 one\n   4 drwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -1sh", "total 1.5M\n8.0K big\n   0 e0\n1.5M huge\n4.0K one\n4.0K sub\n[0]"],
  ["ROOT:ls -lh | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1.5M\n-rw-r--r-- 1 root root 4.9K big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 1.5M huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root 4.0K sub\n[0]"],
  ["ROOT:ls -l --si | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1.6M\n-rw-r--r-- 1 root root 5.0k big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 1.5M huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root 4.1k sub\n[0]"],
  ["ROOT:ls -1s --si", "total 1.6M\n8.2k big\n   0 e0\n1.6M huge\n4.1k one\n4.1k sub\n[0]"],
  ["ROOT:ls -ls -h --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n   8K -rw-r--r-- 1 root root    5K big\n   0K -rw-r--r-- 1 root root    0K e0\n1468K -rw-r--r-- 1 root root 1465K huge\n   4K -rw-r--r-- 1 root root    1K one\n   4K drwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ls --block-size=K -h | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1.5M\n8.0K -rw-r--r-- 1 root root 4.9K big\n   0 -rw-r--r-- 1 root root    0 e0\n1.5M -rw-r--r-- 1 root root 1.5M huge\n4.0K -rw-r--r-- 1 root root    1 one\n4.0K drwxr-xr-x 2 root root 4.0K sub\n[0]"],
  ["ROOT:ls -ls --block-size=K -k | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n   8K -rw-r--r-- 1 root root    5K big\n   0K -rw-r--r-- 1 root root    0K e0\n1468K -rw-r--r-- 1 root root 1465K huge\n   4K -rw-r--r-- 1 root root    1K one\n   4K drwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ls -k --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n   8K -rw-r--r-- 1 root root    5K big\n   0K -rw-r--r-- 1 root root    0K e0\n1468K -rw-r--r-- 1 root root 1465K huge\n   4K -rw-r--r-- 1 root root    1K one\n   4K drwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ls --block-size=K --si | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1.6M\n8.2k -rw-r--r-- 1 root root 5.0k big\n   0 -rw-r--r-- 1 root root    0 e0\n1.6M -rw-r--r-- 1 root root 1.5M huge\n4.1k -rw-r--r-- 1 root root    1 one\n4.1k drwxr-xr-x 2 root root 4.1k sub\n[0]"],
  ["ROOT:ls -l --block-size=K -h | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1.5M\n-rw-r--r-- 1 root root 4.9K big\n-rw-r--r-- 1 root root    0 e0\n-rw-r--r-- 1 root root 1.5M huge\n-rw-r--r-- 1 root root    1 one\ndrwxr-xr-x 2 root root 4.0K sub\n[0]"],
  ["ROOT:ls --block-size", "ls: option '--block-size' requires an argument\nTry 'ls --help' for more information.\n[2]"],
  ["ROOT:ls -l --block-size=K --block-size=M | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 2M\n-rw-r--r-- 1 root root 1M big\n-rw-r--r-- 1 root root 0M e0\n-rw-r--r-- 1 root root 2M huge\n-rw-r--r-- 1 root root 1M one\ndrwxr-xr-x 2 root root 1M sub\n[0]"],
  ["ROOT:ls -ln --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n-rw-r--r-- 1 0 0    5K big\n-rw-r--r-- 1 0 0    0K e0\n-rw-r--r-- 1 0 0 1465K huge\n-rw-r--r-- 1 0 0    1K one\ndrwxr-xr-x 2 0 0    4K sub\n[0]"],
  ["ROOT:ls -lS --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n-rw-r--r-- 1 root root 1465K huge\n-rw-r--r-- 1 root root    5K big\ndrwxr-xr-x 2 root root    4K sub\n-rw-r--r-- 1 root root    1K one\n-rw-r--r-- 1 root root    0K e0\n[0]"],
  ["ROOT:ls -1s1 --block-size=1", "total 1519616\n   8192 big\n      0 e0\n1503232 huge\n   4096 one\n   4096 sub\n[0]"],
  ["ROOT:ls -1si --block-size=K | sed 's/^ *[0-9]* //'", "total 1484K\n   8K big\n   0K e0\n1468K huge\n   4K one\n   4K sub\n[0]"],
  ["ROOT:ls -l --kibibytes | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484\n-rw-r--r-- 1 root root    5000 big\n-rw-r--r-- 1 root root       0 e0\n-rw-r--r-- 1 root root 1500000 huge\n-rw-r--r-- 1 root root       1 one\ndrwxr-xr-x 2 root root    4096 sub\n[0]"],
  ["ROOT:ls -1s --kibibytes", "total 1484\n   8 big\n   0 e0\n1468 huge\n   4 one\n   4 sub\n[0]"],
  ["ROOT:ls -l --human-readable --block-size=K | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "total 1484K\n-rw-r--r-- 1 root root    5K big\n-rw-r--r-- 1 root root    0K e0\n-rw-r--r-- 1 root root 1465K huge\n-rw-r--r-- 1 root root    1K one\ndrwxr-xr-x 2 root root    4K sub\n[0]"],
  ["ROOT:ls -ld --block-size=K sub | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "drwxr-xr-x 2 root root 4K sub\n[0]"],
  ["ROOT:ls -lR --block-size=K sub | sed 's/ *[A-Z][a-z][a-z] *[0-9]* *[0-9:]* / /'", "sub:\ntotal 0K\n[0]"],
];

describe('ls --block-size against the real GNU ls', () => {
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
