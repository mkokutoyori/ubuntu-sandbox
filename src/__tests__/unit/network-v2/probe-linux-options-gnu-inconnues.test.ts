/*
 * GNU utilities that ignored an option they do not have: `whoami --zorglub`
 * printed the user name, `tty -z`, `nproc --zorglub` and
 * `groups --zorglub` ran as if nothing had been typed. A real coreutils
 * prints `<cmd>: unrecognized option '--zorglub'` (or `invalid option -- 'z'`)
 * and `Try '<cmd> --help' for more information.`, exit status 1.
 *
 * Measured before the change, in two steps. First table (whoami, groups, tty,
 * nproc): 6 of 10 cases fall (all refusals), 4 witnesses pass either way;
 * `uptime` was left out since its own implementation already refuses. Second
 * step (free, env, printenv, uname): 12 cases added, 6 fall (every refusal),
 * the 6 witnesses pass either way. Third step (mkdir, rmdir, rm, cat, wc, tac, tee, basename, dirname): `mkdir
 * --zorglub` used to CREATE a directory named `--zorglub`; 16 cases added, 10
 * refusals fall, the 6 valid forms pass either way. Fourth step (ls, head, sort,
 * uniq, cut, tr; `ls --zorglub` listed the directory and `head --zorglub`
 * printed nothing): 14 cases added, 7 refusals fall, the 7 valid forms pass
 * either way. Option tables are the GNU
 * coreutils/procps ones from memory, not from a fetched page; they sit on
 * the existing getopt reader in commands/Getopt.ts.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

function pc(): Sh {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  return machine;
}

describe('known options still work', () => {
  it.each(['whoami', 'groups', 'tty -s', 'nproc', 'free -m', 'free -h', 'env', 'printenv', 'uname -a', 'uname -r', 'mkdir -p /tmp/a/b', 'rm -rf /tmp/a', 'cat -n /etc/hostname', 'wc -l /etc/hostname', 'basename /a/b', 'dirname /a/b', 'ls -la', 'ls --color=auto', 'head -5 /etc/hostname', 'sort -rn /etc/hostname', 'uniq -c /etc/hostname', 'cut -d: -f1 /etc/passwd', 'tr -d a'])('witness: `%s` is accepted', async (line) => {
    expect(await pc().executeCommand(line)).not.toMatch(/unrecognized option|invalid option|extra operand/);
  });
});

describe('unknown options are refused the way GNU getopt does', () => {
  it.each([
    ['whoami --zorglub', "whoami: unrecognized option '--zorglub'"],
    ['whoami zorglub', "whoami: extra operand 'zorglub'"],
    ['groups --zorglub', "groups: unrecognized option '--zorglub'"],
    ['tty -z', "tty: invalid option -- 'z'"],
    ['tty --zorglub', "tty: unrecognized option '--zorglub'"],
    ['nproc --zorglub', "nproc: unrecognized option '--zorglub'"],
    ['free --zorglub', "free: unrecognized option '--zorglub'"],
    ['free -z', "free: invalid option -- 'z'"],
    ['env --zorglub', "env: unrecognized option '--zorglub'"],
    ['printenv --zorglub', "printenv: unrecognized option '--zorglub'"],
    ['uname --zorglub', "uname: unrecognized option '--zorglub'"],
    ['uname -z', "uname: invalid option -- 'z'"],
    ['mkdir --zorglub', "mkdir: unrecognized option '--zorglub'"],
    ['rm --zorglub', "rm: unrecognized option '--zorglub'"],
    ['rm -z x', "rm: invalid option -- 'z'"],
    ['cat --zorglub', "cat: unrecognized option '--zorglub'"],
    ['wc --zorglub', "wc: unrecognized option '--zorglub'"],
    ['tac --zorglub', "tac: unrecognized option '--zorglub'"],
    ['tee --zorglub', "tee: unrecognized option '--zorglub'"],
    ['basename --zorglub', "basename: unrecognized option '--zorglub'"],
    ['dirname --zorglub', "dirname: unrecognized option '--zorglub'"],
    ['ls --zorglub', "ls: unrecognized option '--zorglub'"],
    ['ls -y', "ls: invalid option -- 'y'"],
    ['head --zorglub', "head: unrecognized option '--zorglub'"],
    ['sort --zorglub', "sort: unrecognized option '--zorglub'"],
    ['uniq --zorglub', "uniq: unrecognized option '--zorglub'"],
    ['cut --zorglub', "cut: unrecognized option '--zorglub'"],
    ['tr --zorglub', "tr: unrecognized option '--zorglub'"],
    ['rmdir --zorglub', "rmdir: unrecognized option '--zorglub'"],
  ])('`%s`', async (line, message) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain(message);
    expect(output).toContain(`Try '${line.split(' ')[0]} --help' for more information.`);
  });
});
