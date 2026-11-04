/*
 * shred answered `command not found`. ShredCommand.ts overwrites the file with the requested number of
 * passes (random bytes, a last zero pass with -z), rounds the size up to a 4096-byte block unless -x or
 * -s fixes it (-s never truncates), removes with -u through the rename chain of the real tool, prints
 * the -v progress lines, and refuses bad pass counts, sizes, directories and missing files. The bytes
 * are random, so only sizes, messages and statuses are asserted.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). NOT covered: the stderr of an earlier command of a `;` list.
 *
 * Measured against the commit before (worktree): 32 cases; the command did not exist, all of them fall.
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
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred f; wc -c f", "4096 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n 1 -v f", "shred: f: pass 1/1 (random)...\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -u f; ls f", "ls: cannot access 'f': No such file or directory\n[2]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -z f; wc -c f; od -c f | head -n 2", "4096 f\n0000000  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0  \\0\n*\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred nofile", "shred: nofile: failed to open for writing: No such file or directory\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred", "shred: missing file operand\nTry 'shred --help' for more information.\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -s 4 -n1 f; wc -c f", "12 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n x f", "shred: invalid number of passes: 'x'\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -x f", "[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -x -n1 f; wc -c f", "12 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred d", "shred: d: failed to open for writing: Is a directory\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -f -n1 f; wc -c f", "4096 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -v f", "shred: f: pass 1/3 (random)...\nshred: f: pass 2/3 (random)...\nshred: f: pass 3/3 (random)...\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -vu -n1 f", "shred: f: pass 1/1 (random)...\nshred: f: removing\nshred: f: renamed to 0\nshred: f: removed\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -s 20 -n1 f; wc -c f", "20 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -s 1K -n1 f; wc -c f", "1024 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n 0 f; wc -c f", "12 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n 0 -z f; wc -c f", "4096 f\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n -1 f", "shred: invalid number of passes: '-1'\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -s x f", "shred: invalid file size: 'x'\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -u -v f f", "shred: f: pass 1/3 (random)...\nshred: f: pass 2/3 (random)...\nshred: f: pass 3/3 (random)...\nshred: f: removing\nshred: f: renamed to 0\nshred: f: removed\nshred: f: failed to open for writing: No such file or directory\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred --iterations=1 -v g", "shred: g: pass 1/1 (random)...\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -vz g", "shred: g: pass 1/4 (random)...\nshred: g: pass 2/4 (random)...\nshred: g: pass 3/4 (random)...\nshred: g: pass 4/4 (000000)...\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred --exact -s 5 g", "[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred --remove=wipe -v g", "shred: g: pass 1/3 (random)...\nshred: g: pass 2/3 (random)...\nshred: g: pass 3/3 (random)...\nshred: g: removing\nshred: g: renamed to 0\nshred: g: removed\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred --random-source=nofile g", "shred: nofile: No such file or directory\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred e; wc -c e", "0 e\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -s 10 e; wc -c e", "10 e\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -vu d/../g", "shred: d/../g: pass 1/3 (random)...\nshred: d/../g: pass 2/3 (random)...\nshred: d/../g: pass 3/3 (random)...\nshred: d/../g: removing\nshred: d/../g: renamed to d/../0\nshred: d/../g: removed\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; mkdir d/sub ; : > d/sub/abc ; shred -vu d/sub/abc", "shred: d/sub/abc: removing\nshred: d/sub/abc: renamed to d/sub/000\nshred: d/sub/000: renamed to d/sub/00\nshred: d/sub/00: renamed to d/sub/0\nshred: d/sub/abc: removed\n[0]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred - </dev/null", "shred: -: invalid file type\n[1]"],
  ["printf 'hello\\nworld\\n' > f ; printf 'a' > g ; : > e ; mkdir -p d ; shred -n 2 -v f g", "shred: f: pass 1/2 (random)...\nshred: f: pass 2/2 (random)...\nshred: g: pass 1/2 (random)...\nshred: g: pass 2/2 (random)...\n[0]"],
];

describe('shred overwrites like GNU shred', () => {
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
