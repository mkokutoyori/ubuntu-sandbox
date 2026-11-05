/*
 * expr was a hand-written recursive descent over Number: 64-bit precision lost (9223372036854775807 + 1 printed 9223372036854776000, a product
 * printed 1e+40), messages and statuses of its own invention ('argument expected', 'non-integer argument: a' with status 3, 'internal error'
 * for a bad regular expression), keywords evaluated without their operands (expr length answered 'length'), '-- ' not stripped and
 * --help / --version silent. ExprEvaluator.ts now follows coreutils 9.4 expr.c function by function (eval to eval7): BigInt values,
 * the unevaluated-branch flag of | and &, the 'missing argument after', 'expecting )', 'unexpected argument' diagnostics, status 2 for
 * every invalid expression, 0/1 from the value, regex errors from the shared POSIX translator, --help/--version only as the sole
 * argument (and its getopt abbreviations), integer comparison of integer-looking strings and code-point comparison otherwise.
 *
 * Every expected string was produced by the real expr 9.4 of the dev container; the version number and year are rewritten to the
 * simulated distribution's 8.32 / 2020, the 'line 1: ' prefix of bash -c is dropped.
 *
 * Measured against the commit before (worktree): 38 of 94 cases fall; the other 56 pass either way (operator precedence, comparisons, quoting and the
 * string keywords were already right) and serve as witnesses that the lab and the port agree.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string>; executor: { runAsUser(user: string, run: () => Promise<string>): Promise<string> } };

const SETUP = "mkdir -p sub/deep sub/empty; printf 'hi\\n' > a.txt; printf 'yo\\n' > sub/b.log; : > sub/deep/c.txt; printf 'x%.0s' $(seq 1 3000) > big; ln -sf a.txt lnk; ln -sfn sub dlnk; ln -sfn nowhere dang; ln -sfn lnk2 lnk2; printf 'a.txt\\0sub\\0' > list0; chmod 600 sub/b.log; chmod 755 sub/deep; seq 1 10 > nums; printf 'foo bar\\nbaz qux\\nFoo BAR\\nhello world\\nbaz qux\\nbaz qux\\nz:y:x\\n' > words; printf 'a\\0b\\0a\\0' > z";

const normalise = (text: string): string => text.replace(/line 1: /g, '').replace(/[\u2018\u2019]/g, "'").replace(/\n+$/, '');

async function lab(): Promise<Sh> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('mkdir -p /tmp/ff; cd /tmp/ff');
  return machine;
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["expr 1 +", "expr: syntax error: missing argument after '+'\n[2]"],
  ["expr", "expr: missing operand\nTry 'expr --help' for more information.\n[2]"],
  ["expr 1 / 0", "expr: division by zero\n[2]"],
  ["expr 1 % 0", "expr: division by zero\n[2]"],
  ["expr 1 + a", "expr: non-integer argument\n[2]"],
  ["expr 1 2", "expr: syntax error: unexpected argument '2'\n[2]"],
  ["expr 5 - 3 - 1", "1\n[0]"],
  ["expr ''", "\n[1]"],
  ["expr 0", "0\n[1]"],
  ["expr length", "expr: syntax error: missing argument after 'length'\n[2]"],
  ["expr index abc c", "3\n[0]"],
  ["expr substr abc", "expr: syntax error: missing argument after 'abc'\n[2]"],
  ["expr substr abc 2 1", "b\n[0]"],
  ["expr match abc a", "1\n[0]"],
  ["expr match abc 'a*'", "1\n[0]"],
  ["expr abc : 'a\\(.\\)'", "b\n[0]"],
  ["expr abc : 'x\\(.\\)'", "\n[1]"],
  ["expr abc : '\\('", "expr: Unmatched ( or \\(\n[2]"],
  ["expr abc : '\\)'", "expr: Unmatched ) or \\)\n[2]"],
  ["expr abc : 'a\\{'", "expr: Unmatched \\{\n[2]"],
  ["expr abc : '['", "expr: Invalid regular expression\n[2]"],
  ["expr 3 \\> 2", "1\n[0]"],
  ["expr 3 \\< 2", "0\n[1]"],
  ["expr 3 = 3", "1\n[0]"],
  ["expr 3 != 3", "0\n[1]"],
  ["expr 3 \\>= 3", "1\n[0]"],
  ["expr 3 \\<= 2", "0\n[1]"],
  ["expr abc \\< abd", "1\n[0]"],
  ["expr 1 \\| 0", "1\n[0]"],
  ["expr 0 \\| 0", "0\n[1]"],
  ["expr 0 \\| ''", "0\n[1]"],
  ["expr 1 \\& 0", "0\n[1]"],
  ["expr 1 \\& 2", "1\n[0]"],
  ["expr a \\& b", "a\n[0]"],
  ["expr 2 \\* 3", "6\n[0]"],
  ["expr 7 / 2", "3\n[0]"],
  ["expr 7 % 3", "1\n[0]"],
  ["expr -7 / 2", "-3\n[0]"],
  ["expr 9223372036854775807 + 1", "9223372036854775808\n[0]"],
  ["expr 99999999999999999999 + 1", "100000000000000000000\n[0]"],
  ["expr 99999999999999999999 \\* 99999999999999999999", "9999999999999999999800000000000000000001\n[0]"],
  ["expr - 1", "expr: syntax error: unexpected argument '1'\n[2]"],
  ["expr -1 + 2", "1\n[0]"],
  ["expr + 1", "1\n[0]"],
  ["expr -- 1 + 2", "3\n[0]"],
  ["expr --version | head -1", "expr (GNU coreutils) 8.32\n[0]"],
  ["expr --help | head -2", "Usage: expr EXPRESSION\n  or:  expr OPTION\n[0]"],
  ["expr --nosuch", "--nosuch\n[0]"],
  ["expr -x", "-x\n[0]"],
  ["expr length ''", "0\n[1]"],
  ["expr length abc", "3\n[0]"],
  ["expr length \"\u00e9\"", "1\n[0]"],
  ["expr index abc xyz", "0\n[1]"],
  ["expr index abc ''", "0\n[1]"],
  ["expr substr abc 0 1", "\n[1]"],
  ["expr substr abc 1 0", "\n[1]"],
  ["expr substr abc 2 99", "bc\n[0]"],
  ["expr substr abc -1 2", "\n[1]"],
  ["expr substr abc x 1", "\n[1]"],
  ["expr substr \"\u00e9\" 1 1", "\u00e9\n[0]"],
  ["expr 1 + 2 \\* 3", "7\n[0]"],
  ["expr \\( 1 + 2 \\) \\* 3", "9\n[0]"],
  ["expr \\( 1 + 2", "expr: syntax error: expecting ')' after '2'\n[2]"],
  ["expr 1 + 2 \\)", "expr: syntax error: unexpected argument ')'\n[2]"],
  ["expr \\( \\)", "expr: syntax error: unexpected ')'\n[2]"],
  ["expr + + ", "+\n[0]"],
  ["expr + length abc", "expr: syntax error: unexpected argument 'abc'\n[2]"],
  ["expr length length", "expr: syntax error: missing argument after 'length'\n[2]"],
  ["expr match", "expr: syntax error: missing argument after 'match'\n[2]"],
  ["expr match a", "expr: syntax error: missing argument after 'a'\n[2]"],
  ["expr a : b : c", "0\n[1]"],
  ["expr 1 : 1", "1\n[0]"],
  ["expr 10 : '.*'", "2\n[0]"],
  ["expr abc : '.*' + 1", "4\n[0]"],
  ["expr a '|' b", "a\n[0]"],
  ["expr '' '|' ''", "0\n[1]"],
  ["expr 0 '|' 00", "0\n[1]"],
  ["expr 00 '&' 1", "0\n[1]"],
  ["expr 007 + 1", "8\n[0]"],
  ["expr 0x10 + 1", "expr: non-integer argument\n[2]"],
  ["expr 1e3 + 1", "expr: non-integer argument\n[2]"],
  ["expr ' 1' + 1", "expr: non-integer argument\n[2]"],
  ["expr '1 ' + 1", "expr: non-integer argument\n[2]"],
  ["expr \"+1\" + 1", "expr: non-integer argument\n[2]"],
  ["expr -0 + 1", "1\n[0]"],
  ["expr 3 - 5", "-2\n[0]"],
  ["expr 5 \\* -1", "-5\n[0]"],
  ["expr 2 \\< 10", "1\n[0]"],
  ["expr 2 \\< a", "1\n[0]"],
  ["expr a \\< 2", "0\n[1]"],
  ["expr 10 = 10.0", "0\n[1]"],
  ["expr 1 = 01", "1\n[0]"],
  ["expr ab = ab", "1\n[0]"],
  ["expr ab \\> aa", "1\n[0]"],
];

describe('expr against the real expr', () => {
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
