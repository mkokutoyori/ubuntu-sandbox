/*
 * csplit answered `command not found`. CsplitCommand.ts is a port of csplit.c 9.4 (fetched from the
 * v9.4 tag): line-number, /regexp/ and %regexp% patterns with offsets, {N} and {*} repeats, the
 * buffer semantics that decide `line number out of range` and `match not found` (with the repetition
 * suffix), the byte counts printed on standard output (flushed before an error() diagnostic and after
 * an fprintf one, as the real stdio does), -f, -b with the validated printf suffix, -n, -k, -s/-q,
 * -z, --suppress-matched, and the cleanup that deletes the files created before a failure. Regular
 * expressions go through the same POSIX BRE translator as grep and sed.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). NOT covered, because the machines differ: the stderr of an earlier command
 * of a `;` list (the harness of the real side drops it) and the version banner.
 *
 * Measured against the commit before (worktree): 93 cases; the command did not exist, all 93 fall.
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
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 3 6; echo xx*; cat xx00", "4\n6\n11\nxx00 xx01 xx02\n1\n2\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -f p -b %03d s10 '/5/'; echo p*", "8\n13\np000 p001\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -s s10 4; echo done", "done\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '{2}'", "csplit: '{2}': invalid pattern\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 20", "csplit: '20': line number out of range\n21\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10", "csplit: missing operand after 's10'\nTry 'csplit --help' for more information.\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/x/'", "csplit: '/x/': match not found\n21\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -n 3 s10 5; echo xx*", "8\n13\nxx000 xx001\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --suppress-matched s10 5; cat xx00 xx01", "8\n11\n1\n2\n3\n4\n6\n7\n8\n9\n10\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -z s10 11", "csplit: '11': line number out of range\n21\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '%5%'; echo xx*", "13\nxx00\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/3/' '{*}'; echo xx*", "4\n17\nxx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/2/+1' '/7/-1'; echo xx*; cat xx01", "4\n6\n11\nxx00 xx01 xx02\n3\n4\n5\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 0", "csplit: 0: line number must be greater than zero\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 abc", "csplit: 'abc': invalid pattern\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 5 3", "csplit: line number '3' is smaller than preceding line number, 5\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 5 5", "csplit: warning: line number '5' is the same as preceding line number\n8\n0\n13\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 4 8 '{1}'", "csplit: '8': line number out of range on repetition 1\n6\n8\n7\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 4 '{1}'", "6\n8\n7\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/' '{1}'", "csplit: '/5/': match not found on repetition 1\n8\n13\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/' '{x}'", "csplit: '{x'}: integer required between '{' and '}'\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/' '{2'", "csplit: '{2': '}' is required in repeat count\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5'", "csplit: /5: closing delimiter '/' missing\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/x'", "csplit: '/5/x': integer expected after delimiter\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/+x'", "csplit: '/5/+x': integer expected after delimiter\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/\\(/'", "csplit: '/\\\\(/': invalid regular expression: Unmatched ( or \\(\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/+0'", "8\n13\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/-2'; cat xx00 xx01", "4\n17\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '/5/+2'; cat xx00; cat xx01", "12\n9\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit nofile 3", "csplit: cannot open 'nofile' for reading: No such file or directory\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit - 3 < s10", "4\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; cat s10 | csplit - 3 ; echo xx*", "4\n17\nxx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 3 -f q", "4\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -f q s10 3; echo q*", "4\n17\nq00 q01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --prefix=r --digits=4 s10 3; echo r*", "4\n17\nr0000 r0001\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -n x s10 3", "csplit: invalid number: 'x'\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -n 0 s10 3; echo xx*", "4\n17\nxx0 xx1\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%d.txt' s10 3; echo xx*", "4\n17\nxx0.txt xx1.txt\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%x' s10 3 6; echo xx*", "4\n6\n11\nxx0 xx1 xx2\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%02d%02d' s10 3", "csplit: too many % conversion specifications in suffix\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b 'abc' s10 3", "csplit: missing % conversion specification in suffix\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%s' s10 3", "csplit: invalid conversion specifier in suffix: s\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%#d' s10 3", "csplit: invalid flags in conversion specification: %#d\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b \"%'x\" s10 3", "csplit: invalid flags in conversion specification: %'x\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%5.3d' s10 3; echo xx*", "4\n17\nxx  000 xx  001\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -b '%%d' s10 3", "csplit: missing % conversion specification in suffix\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -q s10 3 ; echo xx*", "xx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --quiet s10 3", "[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --silent s10 3", "[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -z s10 1", "21\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -z t 1 '{1}'", "2\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/' '{*}'; echo xx*; cat xx00 xx01 xx02", "2\n6\n11\nxx00 xx01 xx02\na\nfoo\nb\nfoo\nc\nbar\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '%foo%' '/foo/'; echo xx*; cat xx00", "6\n11\nxx00 xx01\nfoo\nb\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/' '{1}'; echo xx*", "2\n6\n11\nxx00 xx01 xx02\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/' '{2}'", "csplit: '/foo/': match not found on repetition 2\n2\n6\n11\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/' '{3}'", "csplit: '/foo/': match not found on repetition 2\n2\n6\n11\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/bar/+1'; cat xx01", "18\n1\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/bar/+2'; cat xx01", "19\n0\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/bar/+3'", "csplit: '/bar/+3': line number out of range\n19\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t 7", "18\n1\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t 8", "csplit: '8': line number out of range\n19\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t 3 '{*}'", "csplit: '3': line number out of range on repetition 2\n6\n8\n5\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t 2 '{1}'; echo xx*", "2\n6\n11\nxx00 xx01 xx02\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --suppress-matched t '/foo/' '{*}'; cat xx00 xx01 xx02", "2\n2\n7\na\nb\nc\nbar\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --suppress-matched t 3; cat xx00 xx01", "6\n11\na\nfoo\nfoo\nc\nbar\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --suppress-matched t '/zzz/'", "csplit: '/zzz/': match not found\n19\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --suppress-matched t 8", "19\n0\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/^d/'; cat xx01", "18\n1\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/d$/'; cat xx01", "18\n1\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/D/'", "csplit: '/D/': match not found\n19\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/./'; cat xx00; echo ---; cat xx01", "0\n19\n---\na\nfoo\nb\nfoo\nc\nbar\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/\\./'", "csplit: '/\\\\./': match not found\n19\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t ':foo:'", "csplit: ':foo:': invalid pattern\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '%a%+1' '/foo/'; echo xx*", "6\n11\nxx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/-1'; cat xx00; echo ---; cat xx01", "0\n19\n---\na\nfoo\nb\nfoo\nc\nbar\nd[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/foo/-3'", "csplit: '/foo/-3': line number out of range\n0\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t '/b/-1' '{*}'", "2\n10\n7\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf 'x\\n' > one ; csplit one 1", "0\n2\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf 'x\\n' > one ; csplit one 2", "csplit: '2': line number out of range\n2\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf 'x\\n' > one ; csplit one '/x/'; echo xx*", "0\n2\nxx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf '' > empty ; csplit empty 1", "csplit: input disappeared\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf '' > empty ; csplit empty '/x/'", "csplit: '/x/': match not found\n0\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; printf '' > empty ; csplit empty '%x%'", "csplit: '%x%': match not found\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit t 1 ; echo xx*", "0\n19\nxx00 xx01\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 3 3", "csplit: warning: line number '3' is the same as preceding line number\n4\n0\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 3 '{0}'", "4\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit --bogus", "csplit: unrecognized option '--bogus'\nTry 'csplit --help' for more information.\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -x s10 3", "csplit: invalid option -- 'x'\nTry 'csplit --help' for more information.\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 +3", "4\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 ' 3'", "4\n17\n[0]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 '3 '", "csplit: '3 ': invalid pattern\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit -f nodir/y s10 3", "csplit: nodir/y00: No such file or directory\n[1]"],
  ["seq 1 10 > s10 ; printf 'a\\nfoo\\nb\\nfoo\\nc\\nbar\\nd' > t ; csplit s10 3 ; csplit s10 5 ; cat xx00", "4\n17\n8\n13\n1\n2\n3\n4\n[0]"],
];

describe('csplit follows GNU csplit', () => {
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
