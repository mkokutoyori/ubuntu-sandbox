/*
 * join did not exist (`bash: join: command not found`). JoinCommand.ts is a port of GNU join:
 * blank- and -t-delimited fields, -1/-2/-j join fields, -a/-v unpairable lines, -e filler,
 * -o field lists and `-o auto`, -i, --header, -z, the cross product of equal keys, the order
 * check of --check-order / the default (reported only once an unpairable line was seen) /
 * --nocheck-order with the diagnostics and statuses of each option.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by
 * running the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised,
 * scratch directory rewritten to /tmp/ff). NOT covered, because the machines differ: the
 * version banner and the obsolete `-j1 FIELD` form, whose diagnostics were not reproduced.
 *
 * Measured against the commit before (worktree): 155 cases; the command did not exist, so all
 * of them fall except the ones that expect `command not found` (none).
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
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 l r", "a 1 x\nb 2 y\nc 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a2 l r", "a 1 x\nb 2 y\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 -a2 l r", "a 1 x\nb 2 y\nc 3\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v1 l r", "c 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v2 l r", "d z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v1 -v2 l r", "c 3\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -1 2 -2 2 l r", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -j 1 l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -j1 l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, lc rc", "a,1,x\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t , lc rc", "a,1,x\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.1,2.2 l r", "a x\nb y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.1 -o 2.2 l r", "a x\nb y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o '1.1 2.2' l r", "a x\nb y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o auto l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o auto -a1 l r", "a 1 x\nb 2 y\nc 3 \n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -e X -a1 -o 1.1,2.2 l r", "a x\nb y\nc X\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -e X -a2 -o 1.1,2.2 l r", "a x\nb y\nX z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -e X -a1 -a2 -o auto l r", "a 1 x\nb 2 y\nc 3 X\nd X z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -i l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --ignore-case l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --check-order l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --nocheck-order l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --header l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -z l r", "a 1 b 2 c 3  x b y d z \u0000[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join", "join: missing operand\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join l", "join: missing operand after 'l'\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join l nofile", "join: nofile: No such file or directory\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join nofile l", "join: nofile: No such file or directory\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -1 0 l r", "join: invalid field number: '0'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -2 0 l r", "join: invalid field number: '0'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -j 0 l r", "join: invalid field number: '0'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 3.1 l r", "join: invalid file number in field spec: '3.1'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.x l r", "join: invalid field number: 'x'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1 l r", "join: invalid field specifier: '1'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o x l r", "join: invalid file number in field spec: 'x'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t ab l r", "join: multi-character tab 'ab'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --bogus l r", "join: unrecognized option '--bogus'\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a3 l r", "join: invalid field number: '3'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a0 l r", "join: invalid field number: '0'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v3 l r", "join: invalid field number: '3'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -j x l r", "join: invalid field number: 'x'\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -e '' -a1 l r", "a 1 x\nb 2 y\nc 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join - r < l", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join l - < r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join - - < l", "join: both files cannot be standard input: No such file or directory\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t '' l r", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join u r", "join: u:2: is not sorted: a 2\nb 1 y\njoin: input is not in sorted order\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --check-order u r", "join: u:2: is not sorted: a 2\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 --nocheck-order u r", "b 1 y\na 2\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 -a2 --nocheck-order u r", "a x\nb 1 y\na 2\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v1 --nocheck-order u r", "a 2\n[0]"],
  ["printf 'a 1\\na 2\\n' > d1 ; printf 'a x\\na y\\n' > d2 ; join d1 d2", "a 1 x\na 1 y\na 2 x\na 2 y\n[0]"],
  ["printf 'a 1\\na 2\\n' > d1 ; printf 'a x\\na y\\n' > d2 ; join -a1 -a2 d1 d2", "a 1 x\na 1 y\na 2 x\na 2 y\n[0]"],
  ["printf 'A 1\\nb 2\\n' > c1 ; printf 'a x\\nB y\\n' > c2 ; join -i c1 c2", "A 1 x\nb 2 y\n[0]"],
  ["printf 'A 1\\nb 2\\n' > c1 ; printf 'a x\\nB y\\n' > c2 ; join c1 c2", "join: c2:2: is not sorted: B y\njoin: input is not in sorted order\n[1]"],
  ["printf '  a   1\\n b 2\\n' > s1 ; printf 'a x\\nb y\\n' > s2 ; join s1 s2", "a 1 x\nb 2 y\n[0]"],
  ["printf '  a   1\\n b 2\\n' > s1 ; printf 'a x\\nb y\\n' > s2 ; join -t ' ' s1 s2", "[0]"],
  ["printf 'k v\\n' > h1 ; printf 'a 1\\n' > h2 ; join --header h1 h2", "k v 1\n[0]"],
  ["printf 'id name\\n1 a\\n2 b\\n' > h1 ; printf 'id val\\n1 x\\n3 y\\n' > h2 ; join --header h1 h2", "id name val\n1 a x\n[0]"],
  ["printf 'id name\\n1 a\\n2 b\\n' > h1 ; printf 'id val\\n1 x\\n3 y\\n' > h2 ; join --header -a1 h1 h2", "id name val\n1 a x\n2 b\n[0]"],
  ["printf 'a:b:c\\n' > t1 ; printf 'x:b:y\\n' > t2 ; join -t: -1 2 -2 2 t1 t2", "b:a:c:x:y\n[0]"],
  ["printf 'a:b:c\\n' > t1 ; printf 'x:b:y\\n' > t2 ; join -t: -1 2 -2 2 -o 0,1.1,2.3 t1 t2", "b:a:y\n[0]"],
  ["printf 'a:b:c\\n' > t1 ; printf 'x:b:y\\n' > t2 ; join -t: -1 2 -2 2 -o 0 t1 t2", "b\n[0]"],
  ["printf 'a:b:c\\n' > t1 ; printf 'x:b:y\\n' > t2 ; join -t: -1 2 -2 2 -o 1.5 t1 t2", "\n[0]"],
  ["printf 'a:b:c\\n' > t1 ; printf 'x:b:y\\n' > t2 ; join -t: -1 2 -2 2 -o 1.0 t1 t2", "join: invalid field number: '0'\n[1]"],
  ["printf '1 a\\n' > e1 ; printf '1\\n' > e2 ; join e1 e2", "1 a\n[0]"],
  ["printf '1 a\\n' > e1 ; printf '1\\n' > e2 ; join -o 1.2,2.2 e1 e2", "a \n[0]"],
  ["printf '1 a\\n' > e1 ; printf '1\\n' > e2 ; join -e Z -o 1.2,2.2 e1 e2", "a Z\n[0]"],
  ["printf '1 a\\n' > e1 ; printf '1\\n' > e2 ; join -o auto e1 e2", "1 a\n[0]"],
  ["printf '1 a b\\n' > e1 ; printf '1 x\\n' > e2 ; join -o auto e1 e2", "1 a b x\n[0]"],
  ["printf '1 a b\\n' > e1 ; printf '1 x\\n' > e2 ; join -o auto -e Q e1 e2", "1 a b x\n[0]"],
  ["printf 'a 1\\n\\nb 2\\n' > g1 ; printf 'a x\\nb y\\n' > g2 ; join g1 g2", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\n\\nb 2\\n' > g1 ; printf 'a x\\nb y\\n' > g2 ; join --nocheck-order g1 g2", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\n' > nn1 ; printf 'a x' > nn2 ; join nn1 nn2", "a 1 x\n[0]"],
  ["printf 'a 1' > nn1 ; printf 'a x' > nn2 ; join nn1 nn2", "a 1 x\n[0]"],
  ["printf 'a\\0' > z1 ; printf 'a\\0' > z2 ; join -z z1 z2", "a\u0000[0]"],
  ["printf 'a 1\\0b 2\\0' > z1 ; printf 'a x\\0b y\\0' > z2 ; join -z z1 z2", "a 1 x\u0000b 2 y\u0000[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.1,2.2,1.2 l r", "a x 1\nb y 2\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 -v1 l r", "c 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a 1 l r", "a 1 x\nb 2 y\nc 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v 2 l r", "d z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -1 1 -2 1 l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -11 -21 l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, -j2 lc rc", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 2.1,1.1 l r", "a a\nb b\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.1,,2.1 l r", "join: invalid file number in field spec: ''\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o ',' l r", "join: invalid file number in field spec: ''\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -o 1.1, l r", "join: invalid file number in field spec: ''\n[1]"],
  ["printf 'a 1\\nc 2\\nb 3\\n' > o1 ; printf 'a x\\nb y\\nc z\\n' > o2 ; join o1 o2", "a 1 x\njoin: o1:3: is not sorted: b 3\nc 2 z\njoin: input is not in sorted order\n[1]"],
  ["printf 'a 1\\nc 2\\nb 3\\n' > o1 ; printf 'a x\\nb y\\nc z\\n' > o2 ; join --check-order o1 o2", "a 1 x\njoin: o1:3: is not sorted: b 3\n[1]"],
  ["printf 'a 1\\nc 2\\nb 3\\n' > o1 ; printf 'a x\\nb y\\nc z\\n' > o2 ; join --nocheck-order o1 o2", "a 1 x\nc 2 z\n[0]"],
  ["printf 'a 1\\nc 2\\nb 3\\n' > o1 ; printf 'a x\\nb y\\nc z\\n' > o2 ; join -a1 o1 o2", "a 1 x\njoin: o1:3: is not sorted: b 3\nc 2 z\nb 3\njoin: input is not in sorted order\n[1]"],
  ["printf 'a 1\\nb 2\\n' > o1 ; printf 'a x\\nb y\\nz 9\\ny 8\\n' > o2 ; join o1 o2", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\n' > o1 ; printf 'a x\\nb y\\nz 9\\ny 8\\n' > o2 ; join -a2 o1 o2", "a 1 x\nb 2 y\nz 9\ny 8\n[0]"],
  ["printf 'a 1\\nb 2\\n' > o1 ; printf 'a x\\nb y\\nz 9\\ny 8\\n' > o2 ; join --check-order o1 o2", "a 1 x\nb 2 y\njoin: o2:4: is not sorted: y 8\n[1]"],
  ["printf 'a 1\\nb 2\\nx 1\\nw 1\\n' > o1 ; printf 'a x\\nb y\\n' > o2 ; join -a1 o1 o2", "a 1 x\nb 2 y\nx 1\nw 1\n[0]"],
  ["printf 'a 1\\nb 2\\nx 1\\nw 1\\n' > o1 ; printf 'a x\\nb y\\n' > o2 ; join -v1 o1 o2", "x 1\nw 1\n[0]"],
  ["printf '1 a b c\\n2 d e f\\n' > m1 ; printf '1 x y\\n2 z w\\n' > m2 ; join -o 1.2,2.3,0,1.4 m1 m2", "a y 1 c\nd w 2 f\n[0]"],
  ["printf '1 a b c\\n2 d e f\\n' > m1 ; printf '1 x y\\n2 z w\\n' > m2 ; join -o 2.5 m1 m2", "\n\n[0]"],
  ["printf '1 a b c\\n2 d e f\\n' > m1 ; printf '1 x y\\n2 z w\\n' > m2 ; join -e - -o 2.5,1.2 m1 m2", "- a\n- d\n[0]"],
  ["printf '1 a b c\\n2 d e f\\n' > m1 ; printf '1 x y\\n2 z w\\n' > m2 ; join -a1 -a2 -e - -o auto m1 m2", "1 a b c x y\n2 d e f z w\n[0]"],
  ["printf 'k1 a\\nk3 b\\n' > m1 ; printf 'k1 x\\nk2 y\\nk3 z\\n' > m2 ; join -a2 -o 0,1.2,2.2 -e NONE m1 m2", "k1 a x\nk2 NONE y\nk3 b z\n[0]"],
  ["printf 'k1 a\\nk3 b\\n' > m1 ; printf 'k1 x\\nk2 y\\nk3 z\\n' > m2 ; join -v2 -o 0,2.2 m1 m2", "k2 y\n[0]"],
  ["printf 'k1 a\\nk3 b\\n' > m1 ; printf 'k1 x\\nk2 y\\nk3 z\\n' > m2 ; join -a1 -a2 m1 m2", "k1 a x\nk2 y\nk3 b z\n[0]"],
  ["printf 'x k1\\ny k3\\n' > m1 ; printf 'k1 x\\nk3 z\\n' > m2 ; join -1 2 -2 1 m1 m2", "k1 x x\nk3 y z\n[0]"],
  ["printf 'x k1\\ny k3\\n' > m1 ; printf 'k1 x\\nk3 z\\n' > m2 ; join -1 2 -2 1 -o 0,1.1,2.2 m1 m2", "k1 x x\nk3 y z\n[0]"],
  ["printf 'a|1\\nb|2\\n' > p1 ; printf 'a|x\\nb|y\\n' > p2 ; join -t'|' p1 p2", "a|1|x\nb|2|y\n[0]"],
  ["printf 'a|1\\nb|2\\n' > p1 ; printf 'a|x\\nb|y\\n' > p2 ; join -t'|' -o 0,2.2 p1 p2", "a|x\nb|y\n[0]"],
  ["printf 'a||1\\n' > p1 ; printf 'a|x|\\n' > p2 ; join -t'|' p1 p2", "a||1|x|\n[0]"],
  ["printf 'a||1\\n' > p1 ; printf 'a|x|\\n' > p2 ; join -t'|' -e E p1 p2", "a|E|1|x|E\n[0]"],
  ["printf 'a  1\\n' > p1 ; printf 'a x\\n' > p2 ; join -e E p1 p2", "a 1 x\n[0]"],
  ["printf 'a\\n' > p1 ; printf 'a\\n' > p2 ; join p1 p2", "a\n[0]"],
  ["printf 'a\\n' > p1 ; printf 'a\\n' > p2 ; join -o 0,1.1,2.1 p1 p2", "a a a\n[0]"],
  ["printf '\\n' > p1 ; printf '\\n' > p2 ; join p1 p2", "\n[0]"],
  ["printf '\\n' > p1 ; printf '\\n' > p2 ; join -t: p1 p2", "\n[0]"],
  ["printf ' a 1\\n' > p1 ; printf 'a x\\n' > p2 ; join -t: p1 p2", "[0]"],
  ["printf 'a\\t1\\n' > p1 ; printf 'a\\tx\\n' > p2 ; join -t \"$(printf '\\t')\" p1 p2", "a\t1\tx\n[0]"],
  ["printf 'a\\t1\\n' > p1 ; printf 'a x\\n' > p2 ; join p1 p2", "a 1 x\n[0]"],
  ["printf 'a 1\\n' > p1 ; printf 'A x\\n' > p2 ; join -i -o 0,1.1,2.1 p1 p2", "a a A\n[0]"],
  ["printf 'a 1\\n' > p1 ; printf 'A x\\n' > p2 ; join -i p1 p2", "a 1 x\n[0]"],
  ["printf 'a 1\\nA 2\\n' > p1 ; printf 'a x\\n' > p2 ; join -i p1 p2", "a 1 x\nA 2 x\n[0]"],
  ["printf 'a 1\\nB 2\\n' > p1 ; printf 'a x\\nb y\\n' > p2 ; join -i p1 p2", "a 1 x\nB 2 y\n[0]"],
  ["printf 'a 1\\nB 2\\n' > p1 ; printf 'a x\\nb y\\n' > p2 ; join p1 p2", "a 1 x\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 -v1 l r ; echo", "c 3\n\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --header -a1 -a2 l r", "a 1 x\nb 2 y\nc 3\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 --header -v2 l r", "a 1 x\nc 3\nd z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, -o 1.1,2.1 lc rc", "a,a\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, -a1 -a2 -e ZZ -o 0,1.2,2.2 lc rc", "a,1,x\nb,2,ZZ\nc,ZZ,y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v 1 l r", "c 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -v1 -a1 l r", "c 3\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join - l < r", "a x 1\nb y 2\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join l - < r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join - l", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -1 2 l r", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -2 2 l r", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -1 5 l r", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -a1 -1 5 -2 5 l r", " a 1 a x\n a 1 b y\n a 1 d z\n b 2 a x\n b 2 b y\n b 2 d z\n c 3 a x\n c 3 b y\n c 3 d z\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -i -t, lc rc", "a,1,x\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -z --nocheck-order lc rc", "[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --header --check-order u r", "b 1 x\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --header --nocheck-order u r", "b 1 x\n[0]"],
  ["join -", "join: missing operand after '-'\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, -t. l r", "join: incompatible tabs\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -t, -t, lc rc", "a,1,x\n[0]"],
  ["join -e", "join: option requires an argument -- 'e'\nTry 'join --help' for more information.\n[1]"],
  ["join -o", "join: option requires an argument -- 'o'\nTry 'join --help' for more information.\n[1]"],
  ["join -a", "join: option requires an argument -- 'a'\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join -x l r", "join: invalid option -- 'x'\nTry 'join --help' for more information.\n[1]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --nocheck l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --check l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --head l r", "a 1 x\nb 2 y\n[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --zero l r", "a 1 b 2 c 3  x b y d z \u0000[0]"],
  ["printf 'a 1\\nb 2\\nc 3\\n' > l ; printf 'a x\\nb y\\nd z\\n' > r ; printf 'a,1\\nb,2\\n' > lc ; printf 'a,x\\nc,y\\n' > rc ; printf 'b 1\\na 2\\n' > u ; join --ign l r", "a 1 x\nb 2 y\n[0]"],
];

describe('join is implemented and matches GNU join', () => {
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
