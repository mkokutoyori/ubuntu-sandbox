/*
 * enable was a no-op: no listing, no refusal of an unknown name, no option grammar, and 'enable -n NAME' disabled nothing.
 * It is now a builtin of the interpreter (bash/runtime/EnableBuiltin.ts, the disabled set lives in Environment):
 * listing (default, -n, -a, -s, -p), 'not a shell builtin', 'not dynamically loaded' for -d, the shared-object refusal for -f,
 * the invalid-option / missing-argument messages with the usage line (status 2), and a disabled builtin is no longer
 * dispatched, no longer answered by builtin or command -v.
 *
 * Every expected string was produced by the real bash 5.2.21 of the dev container; the 'line 1: ' prefix of bash -c is
 * dropped. Not pinned (recorded in TODO.md): a disabled builtin the executor also serves (type -t, cd) and subshell
 * inheritance of the disabled set in a pipeline stage.
 *
 * Measured against the commit before (worktree): 16 of 23 cases fall. The 7 that pass either way are witnesses
 * of the lab or non-regressions: the empty listings ('enable -n', 'enable -n -s'), the silent successes ('enable -- cd',
 * 'enable -nn cd', 'enable -n cd; enable -a cd; enable -n', 'enable -n cd; enable cd; enable -n') and
 * 'enable -n test; test 1 -eq 1', where the executor still serves test.
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
  ["enable | head -3", "enable .\nenable :\nenable [\n[0]"],
  ["enable | wc -l", "61\n[0]"],
  ["enable -n", "[0]"],
  ["enable -a | wc -l", "61\n[0]"],
  ["enable -s", "enable .\nenable :\nenable break\nenable continue\nenable eval\nenable exec\nenable exit\nenable export\nenable readonly\nenable return\nenable set\nenable shift\nenable source\nenable times\nenable trap\nenable unset\n[0]"],
  ["enable -n -s", "[0]"],
  ["enable nosuch", "bash: enable: nosuch: not a shell builtin\n[1]"],
  ["enable -x", "bash: enable: -x: invalid option\nenable: usage: enable [-a] [-dnps] [-f filename] [name ...]\n[2]"],
  ["enable -f", "bash: enable: -f: option requires an argument\nenable: usage: enable [-a] [-dnps] [-f filename] [name ...]\n[2]"],
  ["enable -nq", "bash: enable: -q: invalid option\nenable: usage: enable [-a] [-dnps] [-f filename] [name ...]\n[2]"],
  ["enable -d nosuch", "bash: enable: nosuch: not a shell builtin\n[1]"],
  ["enable -d cd", "bash: enable: cd: not dynamically loaded\n[1]"],
  ["enable -f /x/y foo", "bash: enable: cannot open shared object /x/y: /x/y: cannot open shared object file: No such file or directory\n[1]"],
  ["enable -- cd", "[0]"],
  ["enable cd nosuch echo", "bash: enable: nosuch: not a shell builtin\n[1]"],
  ["enable -n -- nosuch", "bash: enable: nosuch: not a shell builtin\n[1]"],
  ["enable -nn cd", "[0]"],
  ["enable -n eval; enable -n -s; enable -s -n", "enable -n eval\nenable -n eval\n[0]"],
  ["enable -n cd; enable -n cd; enable -n", "enable -n cd\n[0]"],
  ["enable -n cd; enable -a cd; enable -n", "[0]"],
  ["enable -n cd; enable cd; enable -n", "[0]"],
  ["enable -ps | head -2", "enable .\nenable :\n[0]"],
  ["enable -n test; test 1 -eq 1; echo $?", "0\n[0]"],
];

describe('bash builtins against the real bash: enable', () => {
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
