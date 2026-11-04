/*
 * tee, touch, date, chown and chgrp accepted options they did not evaluate and answered
 * every failure at status 0: `tee --output-error=MODE` was ignored, `touch -t` with `-d`
 * or `-r` was accepted and `--time=bogus` too, `date` had no -I/-R/--rfc-3339/-f/-r, no
 * `%G %:z` or flag/width conversions (`%^a`, `%-d`, `%010Y`, `%5d`), printed `%c` in a
 * shape no locale uses and exited 0 on an invalid date, and `chown`/`chgrp` ignored -v -c
 * -f -h -H -L -P --from --reference --preserve-root, checked permission before validating
 * the owner and answered `missing operand` without the Try line.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container,
 * by running the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes
 * normalised, scratch directory rewritten to /tmp/ff). Lines prefixed ROOT: were run as
 * root on both sides, setup included, because only root can change an owner. NOT covered,
 * because the machines differ: the version banner, `--help`, the system users the real
 * container has and the simulator lacks (games, disk), `ls` columns, readdir order.
 *
 * Measured against the commit before (worktree): 134 cases; at the commit before at least 40 fall (tee 2, touch 4, date 26, chgrp 8 counted per command; the old chown HANGS on one of its cases, so its share could not be counted); the cases that pass either way are the ordinary invocations and serve as the witness that the lab is sound.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["printf 'x\\n' | tee t1 ; cat t1", "x\nx\n[0]"],
  ["printf 'x\\n' | tee -a words > /dev/null ; wc -l words", "8 words\n[0]"],
  ["printf 'x\\n' | tee t1 t2 > /dev/null ; cat t1 t2", "x\nx\n[0]"],
  ["printf 'x\\n' | tee nofile/x", "tee: nofile/x: No such file or directory\nx\n[1]"],
  ["printf 'x\\n' | tee -z", "tee: invalid option -- 'z'\nTry 'tee --help' for more information.\n[1]"],
  ["printf 'x\\n' | tee --bogus t1", "tee: unrecognized option '--bogus'\nTry 'tee --help' for more information.\n[1]"],
  ["printf 'x\\n' | tee -i t1", "x\n[0]"],
  ["printf 'x\\n' | tee -p t1", "x\n[0]"],
  ["printf 'x\\n' | tee --output-error=warn nofile/x t1", "tee: nofile/x: No such file or directory\nx\n[1]"],
  ["printf 'x\\n' | tee --output-error nofile/x t1", "tee: nofile/x: No such file or directory\nx\n[1]"],
  ["printf 'x\\n' | tee --output-error=exit nofile/x t1", "tee: nofile/x: No such file or directory\n[1]"],
  ["printf 'x\\n' | tee --output-error=bogus t1", "tee: invalid argument 'bogus' for '--output-error'\nValid arguments are:\n  - 'warn'\n  - 'warn-nopipe'\n  - 'exit'\n  - 'exit-nopipe'\nTry 'tee --help' for more information.\n[1]"],
  ["printf 'x\\n' | tee sub", "tee: sub: Is a directory\nx\n[1]"],
  ["printf 'x\\n' | tee -a nofile/x sub t1", "tee: nofile/x: No such file or directory\ntee: sub: Is a directory\nx\n[1]"],
  ["touch nf ; ls nf", "nf\n[0]"],
  ["touch -c nf2 ; ls nf2", "ls: cannot access 'nf2': No such file or directory\n[2]"],
  ["touch -d '2020-01-02 03:04:05' nf ; stat -c %y nf", "2020-01-02 03:04:05.000000000 +0000\n[0]"],
  ["touch -t 202001020304.05 nf ; stat -c %y nf", "2020-01-02 03:04:05.000000000 +0000\n[0]"],
  ["touch -a -d '2020-01-02' nf ; stat -c %x nf | cut -c1-10", "2020-01-02\n[0]"],
  ["touch -m -d '2020-01-02' nf ; stat -c %y nf | cut -c1-10", "2020-01-02\n[0]"],
  ["touch -t 99 nf", "touch: invalid date format '99'\n[1]"],
  ["touch -d garbage nf", "touch: invalid date format 'garbage'\n[1]"],
  ["touch -d '@86400' nf ; stat -c %Y nf", "86400\n[0]"],
  ["touch", "touch: missing file operand\nTry 'touch --help' for more information.\n[1]"],
  ["touch --bogus nf", "touch: unrecognized option '--bogus'\nTry 'touch --help' for more information.\n[1]"],
  ["touch sub/nodir/x", "touch: cannot touch 'sub/nodir/x': No such file or directory\n[1]"],
  ["touch -t 202001020304 -d '2021-01-01' nf", "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n[1]"],
  ["touch -t 202001020304 -r words nf", "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n[1]"],
  ["touch -r words -d '2021-01-01' nf2 ; echo $?", "0\n[0]"],
  ["touch -d '2021-01-01' nf ; touch -r nf -d '+1 day' nf2 ; stat -c %y nf2 | cut -c1-10", "2021-01-02\n[0]"],
  ["touch --date=2020-05-05 nf ; stat -c %y nf | cut -c1-10", "2020-05-05\n[0]"],
  ["touch --time=atime -d 2020-05-05 nf ; stat -c %x nf | cut -c1-10", "2020-05-05\n[0]"],
  ["touch --time=bogus nf", "touch: invalid argument 'bogus' for '--time'\nValid arguments are:\n  - 'atime', 'access', 'use'\n  - 'mtime', 'modify'\nTry 'touch --help' for more information.\n[1]"],
  ["touch --time=access -d 2020-05-05 nf ; stat -c %x nf | cut -c1-10", "2020-05-05\n[0]"],
  ["touch --time=use -d 2020-05-05 nf ; stat -c %x nf | cut -c1-10", "2020-05-05\n[0]"],
  ["touch --time=mtime -d 2020-05-05 nf ; stat -c %y nf | cut -c1-10", "2020-05-05\n[0]"],
  ["touch -r nofile nf", "touch: failed to get attributes of 'nofile': No such file or directory\n[1]"],
  ["touch -c nofile ; echo $?", "0\n[0]"],
  ["touch -h lnk ; echo $?", "0\n[0]"],
  ["touch -d '1 day ago' nf ; echo $?", "0\n[0]"],
  ["touch a.txt words ; echo $?", "0\n[0]"],
  ["touch -- -x ; ls -x", "-x  a.txt  big\tdang  dlnk  list0  lnk\tlnk2  nums  sub  words\tz\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' '+%Y-%m-%d %H:%M:%S'", "2020-01-02 03:04:05\n[0]"],
  ["date -u -d '@0' +%s", "0\n[0]"],
  ["date -u -d '2020-01-02' '+%A %B %d %j %U %w'", "Thursday January 02 002 00 4\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' +%I:%M:%S%p", "03:04:05AM\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' '+%e|%k|%l|%y|%C|%h'", " 2| 3| 3|20|20|Jan\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' '+%s %N'", "1577934245 000000000\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' '+%Z %z %:z %::z'", "UTC +0000 +00:00 +00:00:00\n[0]"],
  ["date -u -d '2020-01-02' -R", "Thu, 02 Jan 2020 00:00:00 +0000\n[0]"],
  ["date -u -d '2020-01-02' --iso-8601", "2020-01-02\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' --iso-8601=seconds", "2020-01-02T03:04:05+00:00\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' --rfc-3339=seconds", "2020-01-02 03:04:05+00:00\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' --rfc-3339=ns", "2020-01-02 03:04:05.000000000+00:00\n[0]"],
  ["date -u -d '2020-01-02 03:04:05' --rfc-email", "Thu, 02 Jan 2020 03:04:05 +0000\n[0]"],
  ["date -u -d 'garbage'", "date: invalid date 'garbage'\n[1]"],
  ["date -u -d '2020-02-30'", "date: invalid date '2020-02-30'\n[1]"],
  ["date -u -d '2020-01-02 + 1 day' +%F", "2020-01-03\n[0]"],
  ["date -u -d '2020-01-02 -1 month' +%F", "2019-12-02\n[0]"],
  ["date -u -d '2020-01-02 next monday' +%F", "2020-01-02\n[0]"],
  ["date -u -d '2020-01-02 last friday' +%F", "2020-01-02\n[0]"],
  ["date -u -d '2020-01-02 +2 weeks' +%F", "2020-01-16\n[0]"],
  ["date -u -d '2020-01-02 12:00 tomorrow' '+%F %T'", "2020-01-03 12:00:00\n[0]"],
  ["date -u -d 'yesterday 00:00' +%T", "00:00:00\n[0]"],
  ["date -u -d '1 hour ago' +%s | wc -c", "11\n[0]"],
  ["date -u -d '2020-01-02' '+%G-W%V-%u'", "2020-W01-4\n[0]"],
  ["date -u -d '2020-12-31' '+%G-W%V-%u'", "2020-W53-4\n[0]"],
  ["date -u -d '2021-01-01' '+%G-W%V-%u'", "2020-W53-5\n[0]"],
  ["date -u -d '2020-01-02' '+%^a %^B %#B %-d %_d %010Y'", "THU JANUARY JANUARY 2  2 0000002020\n[0]"],
  ["date -u -d '2020-01-02' '+%5d|%-5d|%_5d'", "00002|2|    2\n[0]"],
  ["date -u -d '2020-01-02' '+%n%t|'", "\n\t|\n[0]"],
  ["date -u -d '2020-01-02' +%", "%\n[0]"],
  ["date -u -d '2020-01-02' '+%Q'", "%Q\n[0]"],
  ["date -u -d '2020-01-02' '+%P'", "am\n[0]"],
  ["date -u -d '2020-01-02 15:00' '+%P %p %r %R %T %D %F %c %x %X'", "pm PM 03:00:00 PM 15:00 15:00:00 01/02/20 2020-01-02 Thu Jan  2 15:00:00 2020 01/02/20 15:00:00\n[0]"],
  ["date -u --date=2020-01-02 +%F", "2020-01-02\n[0]"],
  ["date -u -d '2020-01-02' -I", "2020-01-02\n[0]"],
  ["date -u -d '2020-01-02' -Ihours", "2020-01-02T00+00:00\n[0]"],
  ["date -u -d '2020-01-02 03:04' -Iminutes", "2020-01-02T03:04+00:00\n[0]"],
  ["date -u -d '2020-01-02 03:04' -Ins", "2020-01-02T03:04:00,000000000+00:00\n[0]"],
  ["date -u -d '2020-01-02' -Ibogus", "date: invalid argument 'bogus' for '--iso-8601'\nValid arguments are:\n  - 'hours'\n  - 'minutes'\n  - 'date'\n  - 'seconds'\n  - 'ns'\nTry 'date --help' for more information.\n[1]"],
  ["date -u -r words +%F | wc -c", "11\n[0]"],
  ["date -u -r nofile", "date: nofile: No such file or directory\n[1]"],
  ["date --bogus", "date: unrecognized option '--bogus'\nTry 'date --help' for more information.\n[1]"],
  ["date -u '+%F' extra", "date: extra operand 'extra'\nTry 'date --help' for more information.\n[1]"],
  ["date -u -d '2020-01-02' -d '2021-01-01' +%F", "2021-01-01\n[0]"],
  ["date -u -f /dev/null", "[0]"],
  ["date -u -s 'garbage'", "date: invalid date 'garbage'\n[1]"],
  ["date -u 010203042020.05 +%F", "date: extra operand '+%F'\nTry 'date --help' for more information.\n[1]"],
  ["date -u -d 'TZ=\"Europe/Paris\" 2020-07-01 12:00' '+%F %T %Z'", "2020-07-01 10:00:00 UTC\n[0]"],
  ["ROOT:chown 0 words ; echo $?", "0\n[0]"],
  ["ROOT:chown root:root words ; echo $?", "0\n[0]"],
  ["ROOT:chown nosuch words", "chown: invalid user: 'nosuch'\n[1]"],
  ["ROOT:chown :nosuch words", "chown: invalid group: ':nosuch'\n[1]"],
  ["ROOT:chown root: words ; echo $?", "0\n[0]"],
  ["ROOT:chown -R root sub ; echo $?", "0\n[0]"],
  ["ROOT:chown -v root words", "ownership of 'words' retained as root\n[0]"],
  ["ROOT:chown -v root:root words", "ownership of 'words' retained as root:root\n[0]"],
  ["ROOT:chown -v :root words", "ownership of 'words' retained as root:root\n[0]"],
  ["ROOT:chown -v root: words", "ownership of 'words' retained as root:root\n[0]"],
  ["ROOT:chown -v 0:0 words", "ownership of 'words' retained as root:root\n[0]"],
  ["ROOT:chown -v : words", "ownership of 'words' retained\n[0]"],
  ["ROOT:chown -c root words", "[0]"],
  ["ROOT:chown -f nosuch words ; echo $?", "1\n[0]"],
  ["ROOT:chown root nofile", "chown: cannot access 'nofile': No such file or directory\n[1]"],
  ["ROOT:chown -f root nofile ; echo $?", "1\n[0]"],
  ["ROOT:chown", "chown: missing operand\nTry 'chown --help' for more information.\n[1]"],
  ["ROOT:chown root", "chown: missing operand after 'root'\nTry 'chown --help' for more information.\n[1]"],
  ["ROOT:chown --bogus root words", "chown: unrecognized option '--bogus'\nTry 'chown --help' for more information.\n[1]"],
  ["ROOT:chown -h root lnk", "[0]"],
  ["ROOT:chown --reference=nums root words", "chown: cannot access 'root': No such file or directory\n[1]"],
  ["ROOT:chown --reference=nums words ; echo $?", "0\n[0]"],
  ["ROOT:chown 99999999999 words", "chown: invalid user: '99999999999'\n[1]"],
  ["ROOT:chown root.root words ; echo $?", "0\n[0]"],
  ["ROOT:chown 7:8 words ; stat -c '%u %g' words", "7 8\n[0]"],
  ["ROOT:chown 7:8 words ; chown --from=9 1 words ; stat -c '%u %g' words", "7 8\n[0]"],
  ["ROOT:chown 7:8 words ; chown --from=7 1 words ; stat -c '%u %g' words", "1 8\n[0]"],
  ["ROOT:chown 7:8 words ; chown --from=nosuch 1 words", "chown: invalid user: 'nosuch'\n[1]"],
  ["ROOT:chown 7 lnk ; stat -c '%u' a.txt", "7\n[0]"],
  ["ROOT:chown -h 7 lnk ; stat -c '%u' a.txt", "0\n[0]"],
  ["ROOT:chown -R 7 sub ; stat -c '%u' sub/b.log sub/deep/c.txt", "7\n7\n[0]"],
  ["ROOT:chown -R --preserve-root 7 /", "chown: it is dangerous to operate recursively on '/'\nchown: use --no-preserve-root to override this failsafe\n[1]"],
  ["ROOT:chown 7 words nums ; stat -c '%u' words nums", "7\n7\n[0]"],
  ["ROOT:chgrp root words ; echo $?", "0\n[0]"],
  ["ROOT:chgrp nosuch words", "chgrp: invalid group: 'nosuch'\n[1]"],
  ["ROOT:chgrp -R root sub ; echo $?", "0\n[0]"],
  ["ROOT:chgrp -v root words", "group of 'words' retained as root\n[0]"],
  ["ROOT:chgrp", "chgrp: missing operand\nTry 'chgrp --help' for more information.\n[1]"],
  ["ROOT:chgrp root", "chgrp: missing operand after 'root'\nTry 'chgrp --help' for more information.\n[1]"],
  ["ROOT:chgrp --bogus root words", "chgrp: unrecognized option '--bogus'\nTry 'chgrp --help' for more information.\n[1]"],
  ["ROOT:chgrp 0 words ; echo $?", "0\n[0]"],
  ["ROOT:chgrp --reference=nums words ; echo $?", "0\n[0]"],
  ["ROOT:chgrp -f nosuch words ; echo $?", "1\n[0]"],
  ["ROOT:chgrp -h 5 lnk ; stat -c %g a.txt", "0\n[0]"],
];

describe('coreutils batch 5 evaluates the options it accepts', () => {
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
