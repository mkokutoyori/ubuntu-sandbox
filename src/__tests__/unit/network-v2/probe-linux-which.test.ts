/*
 * which accepted any option, answered nothing for -s and exited 0 without operands. handleWhich now follows the debianutils script: getopts 'as' with
 * its 'Illegal option -x' + 'Usage: /usr/bin/which [-as] args' (status 2), -s silences, no operand is status 1.
 *
 * Every expected string was produced by the real /usr/bin/which (the debianutils shell script) of the dev container, the 'line 1: ' prefix
 * of bash -c dropped.
 *
 * Measured against the commit before (worktree): 12 of 20 cases fall. The 8 that pass either way ("which ls", "which nosuch", "-a ls", "-- ls",
 * "/bin/ls", "./nosuch", "-" and "-s ls" for a missing name) are non-regressions and witnesses of the lab.
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
  ["which -x", "Illegal option -x\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which --nosuch", "Illegal option --\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which", "[1]"],
  ["which -a", "[1]"],
  ["which -s ls; echo $?", "0\n[0]"],
  ["which -s nosuch; echo $?", "1\n[0]"],
  ["which --skip-dot ls", "Illegal option --\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which -V", "Illegal option -V\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which --version", "Illegal option --\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which --help", "Illegal option --\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which -a ls | head -2", "/usr/bin/ls\n/bin/ls\n[0]"],
  ["which /bin/ls", "/bin/ls\n[0]"],
  ["which ./nosuch", "[1]"],
  ["which -- ls", "/usr/bin/ls\n[0]"],
  ["which -ax ls", "Illegal option -x\nUsage: /usr/bin/which [-as] args\n[2]"],
  ["which -sa ls; echo $?", "0\n[0]"],
  ["which -", "[1]"],
  ["which ls; echo $?", "/usr/bin/ls\n0\n[0]"],
  ["which nosuch; echo $?", "1\n[0]"],
  ["which -s; echo $?", "1\n[0]"],
];

describe('which against the real which', () => {
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
