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
 * either way. Fifth step (`date --zorglub` printed the date): 4 cases added, 1
 * falls, the 3 valid forms pass either way. Sixth step (md5sum, sha1sum, sha224sum,
 * sha256sum, sha384sum, sha512sum share one option set): 10 cases added, 6 refusals fall, the 4
 * valid forms pass either way. Seventh step (nl, fold, paste, comm, base64): 12 cases added, 5
 * refusals fall, the 7 valid forms pass either way. Eighth step (du: -a, -c, -d/--max-depth were accepted and ignored,
 * only the last target was reported): 10 cases added, 8 fall, 2 witnesses pass either way. Ninth step (rev): 3 cases added, 1 falls (the refusal), 2 witnesses pass either way. Tenth step (find: an unknown predicate was ignored): 10 cases added, 2 refusals fall, 8 valid forms pass either way. Eleventh step (id, chown, sleep, readlink, realpath refuse an unknown option; split evaluates -a -d -x
 * -e -t -C -u --additional-suffix --verbose, and -n always writes N pieces): 15 cases added, 13 fall, 2 pass either way
 * (the split witness and the unchanged `-l 2` layout). Option tables are the GNU
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
  it.each(['whoami', 'groups', 'tty -s', 'nproc', 'free -m', 'free -h', 'env', 'printenv', 'uname -a', 'uname -r', 'mkdir -p /tmp/a/b', 'rm -rf /tmp/a', 'cat -n /etc/hostname', 'wc -l /etc/hostname', 'basename /a/b', 'dirname /a/b', 'ls -la', 'ls --color=auto', 'head -5 /etc/hostname', 'sort -rn /etc/hostname', 'uniq -c /etc/hostname', 'cut -d: -f1 /etc/passwd', 'tr -d a', 'date -u', 'date --iso-8601=seconds', 'date +%Y', 'md5sum -b /etc/hostname', 'sha256sum --tag /etc/hostname', 'sha1sum -t /etc/hostname', 'sha512sum /etc/hostname', 'nl -ba /etc/hostname', 'fold -w5 -s /etc/hostname', 'paste -s -d, /etc/hostname', 'comm -12 /etc/hostname /etc/hostname', 'base64 -w0 /etc/hostname', 'base64 --wrap=0 /etc/hostname', 'nl -w3 -s: /etc/hostname', 'rev /etc/hostname', 'rev -0 /etc/hostname'])('witness: `%s` is accepted', async (line) => {
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
    ['date --zorglub', "date: unrecognized option '--zorglub'"],
    ['ls -y', "ls: invalid option -- 'y'"],
    ['head --zorglub', "head: unrecognized option '--zorglub'"],
    ['sort --zorglub', "sort: unrecognized option '--zorglub'"],
    ['uniq --zorglub', "uniq: unrecognized option '--zorglub'"],
    ['cut --zorglub', "cut: unrecognized option '--zorglub'"],
    ['tr --zorglub', "tr: unrecognized option '--zorglub'"],
    ['rev --zorglub /etc/hostname', "rev: unrecognized option '--zorglub'"],
    ['rmdir --zorglub', "rmdir: unrecognized option '--zorglub'"],
    ['md5sum --zorglub', "md5sum: unrecognized option '--zorglub'"],
    ['md5sum -Q /etc/hostname', "md5sum: invalid option -- 'Q'"],
    ['sha1sum --zorglub', "sha1sum: unrecognized option '--zorglub'"],
    ['sha224sum --zorglub', "sha224sum: unrecognized option '--zorglub'"],
    ['sha256sum -Q /etc/hostname', "sha256sum: invalid option -- 'Q'"],
    ['nl --zorglub /etc/hostname', "nl: unrecognized option '--zorglub'"],
    ['fold --zorglub /etc/hostname', "fold: unrecognized option '--zorglub'"],
    ['paste --zorglub /etc/hostname', "paste: unrecognized option '--zorglub'"],
    ['comm --zorglub /etc/hostname /etc/hostname', "comm: unrecognized option '--zorglub'"],
    ['base64 --zorglub /etc/hostname', "base64: unrecognized option '--zorglub'"],
    ['sha512sum --zorglub', "sha512sum: unrecognized option '--zorglub'"],
  ])('`%s`', async (line, message) => {
    const output = await pc().executeCommand(line);
    expect(output).toContain(message);
    expect(output).toContain(`Try '${line.split(' ')[0]} --help' for more information.`);
  });
});

describe('du evaluates the options it accepts', () => {
  async function du(line: string): Promise<string> {
    const machine = pc() as Sh & { executeCommand(l: string): Promise<string> };
    await machine.executeCommand('mkdir -p /tmp/d/e/g; printf hi > /tmp/d/a; printf hello > /tmp/d/e/f');
    return machine.executeCommand(line);
  }
  it('witness: default lists directories only, deepest first', async () => {
    expect(await du('du /tmp/d')).toBe('1\t/tmp/d/e/g\n1\t/tmp/d/e\n1\t/tmp/d');
  });
  it('witness: -sb is one line of bytes', async () => { expect(await du('du -sb /tmp/d')).toBe('7\t/tmp/d'); });
  it('--zorglub is refused', async () => { expect(await du('du --zorglub /tmp/d')).toContain("du: unrecognized option '--zorglub'"); });
  it('-a lists files too', async () => { expect(await du('du -ab /tmp/d')).toBe('0\t/tmp/d/e/g\n5\t/tmp/d/e/f\n5\t/tmp/d/e\n2\t/tmp/d/a\n7\t/tmp/d'); });
  it('-d 1 stops at depth one', async () => { expect(await du('du -d 1 -b /tmp/d')).toBe('5\t/tmp/d/e\n7\t/tmp/d'); });
  it('--max-depth=0 is -s', async () => { expect(await du('du --max-depth=0 -b /tmp/d')).toBe('7\t/tmp/d'); });
  it('-c appends the total', async () => { expect((await du('du -sbc /tmp/d /tmp/d/e')).split('\n')).toEqual(['7\t/tmp/d', '5\t/tmp/d/e', '12\ttotal']); });
  it('every target is reported', async () => { expect(await du('du -sb /tmp/d/a /tmp/d/e')).toBe('2\t/tmp/d/a\n5\t/tmp/d/e'); });
  it('a bad depth is refused', async () => { expect(await du('du -d x /tmp/d')).toContain("du: invalid maximum depth 'x'"); });
  it('a missing target is reported and the others still run', async () => {
    expect(await du('du -sb /tmp/nope /tmp/d/e')).toBe("du: cannot access '/tmp/nope': No such file or directory\n5\t/tmp/d/e");
  });
});

describe('find refuses a predicate GNU does not have', () => {
  async function find(line: string): Promise<string> {
    const machine = pc();
    await machine.executeCommand('mkdir -p /tmp/d/e; printf hi > /tmp/d/e/f');
    return machine.executeCommand(line);
  }
  it("--zorglub", async () => { expect(await find('find /tmp/d --zorglub')).toBe("find: unknown predicate `--zorglub'"); });
  it("-zorglub x", async () => { expect(await find('find /tmp/d -zorglub x')).toBe("find: unknown predicate `-zorglub'"); });
  it.each([
    'find /tmp/d -name f', 'find /tmp/d -type f -size -2', 'find /tmp/d -links -3', 'find /tmp/d -regex ".*f"',
    'find /tmp/d -maxdepth 1 -print', 'find /tmp/d -uid 0', 'find /tmp/d -newermt 2000-01-01', 'find /tmp/d -name f -o -name e',
  ])('witness: `%s` is not refused', async (line) => {
    expect(await find(line)).not.toContain('unknown predicate');
  });
});

describe('id, chown, sleep, readlink, realpath and split refuse an unknown option', () => {
  it.each([
    ['id --zorglub', "id: unrecognized option '--zorglub'"],
    ['chown --zorglub user /etc/hostname', "chown: unrecognized option '--zorglub'"],
    ['sleep -z 1', "sleep: invalid option -- 'z'"],
    ['readlink --zorglub /etc/hostname', "readlink: unrecognized option '--zorglub'"],
    ['realpath --zorglub /etc', "realpath: unrecognized option '--zorglub'"],
    ['split --zorglub /etc/hostname', "split: unrecognized option '--zorglub'"],
  ])('`%s`', async (line, message) => {
    expect(await pc().executeCommand(line)).toContain(message);
  });
});

describe('split evaluates the options it accepts', () => {
  async function split(args: string): Promise<string[]> {
    const machine = pc();
    await machine.executeCommand('mkdir -p /tmp/s; printf "1\\n2\\n3\\n4\\n5\\n" > /tmp/s/in');
    await machine.executeCommand(`cd /tmp/s; split ${args} in`);
    return (await machine.executeCommand('ls -1 /tmp/s')).split('\n');
  }
  it('witness: -l 2 writes xaa xab xac', async () => { expect(await split('-l 2')).toEqual(['in', 'xaa', 'xab', 'xac']); });
  it('-a 3 lengthens the suffix', async () => { expect(await split('-l 2 -a 3')).toEqual(['in', 'xaaa', 'xaab', 'xaac']); });
  it('-d numbers the pieces', async () => { expect(await split('-l 2 -d')).toEqual(['in', 'x00', 'x01', 'x02']); });
  it('--hex-suffixes starts from a hexadecimal value', async () => { expect(await split('-l 2 --hex-suffixes=a')).toEqual(['in', 'x0a', 'x0b', 'x0c']); });
  it('--additional-suffix', async () => { expect(await split('-l 3 --additional-suffix=.txt')).toEqual(['in', 'xaa.txt', 'xab.txt']); });
  it('-n 2 always writes two pieces', async () => { expect(await split('-n 2')).toEqual(['in', 'xaa', 'xab']); });
  it('-C keeps whole lines under the byte limit', async () => { expect(await split('-C 4')).toEqual(['in', 'xaa', 'xab', 'xac']); });
  it('--verbose names each file', async () => {
    const machine = pc();
    await machine.executeCommand('mkdir -p /tmp/s; printf "1\\n2\\n" > /tmp/s/in');
    expect(await machine.executeCommand('cd /tmp/s; split -l 1 --verbose in')).toBe("creating file 'xaa'\ncreating file 'xab'");
  });
  it('a suffix space too small is refused', async () => {
    const machine = pc();
    await machine.executeCommand('mkdir -p /tmp/s; printf "1\\n2\\n3\\n" > /tmp/s/in');
    expect(await machine.executeCommand('cd /tmp/s; split -l 1 -a 1 -d --numeric-suffixes=9 in')).toContain('output file suffixes exhausted');
  });
});
