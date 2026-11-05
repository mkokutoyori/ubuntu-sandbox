/*
/*
 * sync, sleep, nice, arch, tty and nohup accepted or mis-reported part of their grammar. SyncCommand.ts ports
 * sync.c 9.4 (-d/-f conflicts, --data needing an operand, one diagnostic per missing operand, exit 1);
 * sleep reads the strtold forms (exponent, hex, trailing dot) and ends its usage errors with the Try line;
 * nice takes the obsolete -N form and names the adjustment it was given; arch and tty go through the
 * option guard (tty usage errors exit 2, arch answers --help/--version); nohup answers --help/--version.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). nohup rows that depend on whether the standard streams are terminals, and the
 * not-found message of a wrapped command, are not pinned (TODO.md).
 *
 * Measured against the commit before (worktree): 32 of 65 cases fall.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep; printf 'hi\n' > a.txt; printf 'x%.0s' $(seq 1 3000) > big";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["sync", "[0]"],
  ["sync a.txt", "[0]"],
  ["sync sub", "[0]"],
  ["sync nofile", "sync: error opening 'nofile': No such file or directory\n[1]"],
  ["sync nofile a.txt", "sync: error opening 'nofile': No such file or directory\n[1]"],
  ["sync a.txt nofile", "sync: error opening 'nofile': No such file or directory\n[1]"],
  ["sync -d", "sync: --data needs at least one argument\n[1]"],
  ["sync -f", "[0]"],
  ["sync -d a.txt", "[0]"],
  ["sync -f a.txt", "[0]"],
  ["sync -d -f a.txt", "sync: cannot specify both --data and --file-system\n[1]"],
  ["sync --data", "sync: --data needs at least one argument\n[1]"],
  ["sync --data a.txt", "[0]"],
  ["sync --file-system", "[0]"],
  ["sync --file-system nofile", "sync: error opening 'nofile': No such file or directory\n[1]"],
  ["sync --data --file-system a.txt", "sync: cannot specify both --data and --file-system\n[1]"],
  ["sync --bogus", "sync: unrecognized option '--bogus'\nTry 'sync --help' for more information.\n[1]"],
  ["sync -x", "sync: invalid option -- 'x'\nTry 'sync --help' for more information.\n[1]"],
  ["sync -df a.txt", "sync: cannot specify both --data and --file-system\n[1]"],
  ["sync --da a.txt", "[0]"],
  ["sync --f a.txt", "[0]"],
  ["sync --", "[0]"],
  ["sync -- a.txt", "[0]"],
  ["sync -- -d", "sync: error opening '-d': No such file or directory\n[1]"],
  ["sync -d nofile", "sync: error opening 'nofile': No such file or directory\n[1]"],
  ["sleep abc", "sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep 1x", "sleep: invalid time interval '1x'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep -1", "sleep: invalid option -- '1'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep", "sleep: missing operand\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep 0", "[0]"],
  ["sleep 0.01", "[0]"],
  ["sleep 0.01s", "[0]"],
  ["sleep 0.0001m", "[0]"],
  ["sleep 1 abc", "sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep 0 0", "[0]"],
  ["sleep 1e-2", "[0]"],
  ["sleep 0x1", "[0]"],
  ["sleep --bogus", "sleep: unrecognized option '--bogus'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep -x", "sleep: invalid option -- 'x'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep ''", "sleep: invalid time interval ''\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep .", "sleep: invalid time interval '.'\nTry 'sleep --help' for more information.\n[1]"],
  ["sleep 1.", "[0]"],
  ["sleep .5s", "[0]"],
  ["nice -n x true", "nice: invalid adjustment 'x'\n[125]"],
  ["nice -n 5 true", "[0]"],
  ["nice -x true", "nice: invalid option -- 'x'\nTry 'nice --help' for more information.\n[125]"],
  ["nice --bogus", "nice: unrecognized option '--bogus'\nTry 'nice --help' for more information.\n[125]"],
  ["nice -n", "nice: option requires an argument -- 'n'\nTry 'nice --help' for more information.\n[125]"],
  ["nice -5 true", "[0]"],
  ["nice -n 5", "nice: a command must be given with an adjustment\nTry 'nice --help' for more information.\n[125]"],
  ["nice --adjustment=x true", "nice: invalid adjustment 'x'\n[125]"],
  ["nice --adjustment=3 true", "[0]"],
  ["arch x", "arch: extra operand 'x'\nTry 'arch --help' for more information.\n[1]"],
  ["arch -x", "arch: invalid option -- 'x'\nTry 'arch --help' for more information.\n[1]"],
  ["arch --bogus", "arch: unrecognized option '--bogus'\nTry 'arch --help' for more information.\n[1]"],
  ["arch", "x86_64\n[0]"],
  ["tty -s; echo rc", "rc\n[0]"],
  ["tty --silent; echo rc", "rc\n[0]"],
  ["tty --quiet; echo rc", "rc\n[0]"],
  ["tty x", "tty: extra operand 'x'\nTry 'tty --help' for more information.\n[2]"],
  ["tty --bogus", "tty: unrecognized option '--bogus'\nTry 'tty --help' for more information.\n[2]"],
  ["tty -x", "tty: invalid option -- 'x'\nTry 'tty --help' for more information.\n[2]"],
  ["nohup", "nohup: missing operand\nTry 'nohup --help' for more information.\n[125]"],
  ["nohup --bogus", "nohup: unrecognized option '--bogus'\nTry 'nohup --help' for more information.\n[125]"],
  ["nohup -x", "nohup: invalid option -- 'x'\nTry 'nohup --help' for more information.\n[125]"],
];

describe('sync, sleep, nice, arch, tty, nohup against the real GNU coreutils', () => {
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
