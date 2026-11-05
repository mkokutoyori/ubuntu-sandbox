/*
 * stdbuf answered `command not found`. It now validates its modes (L, 0, a size with the K/M/G and
 * KB/MB/GB suffixes, a bare suffix meaning one unit), refuses line buffering of stdin, a missing
 * operand and a missing mode with status 125, and runs the command in an environment that carries
 * _STDBUF_I/_O/_E and LD_PRELOAD exactly as the real tool leaves it, so printenv and env see them.
 *
 * Every expected string was produced by the real GNU coreutils 9.4 of the dev container, by running
 * the identical line in bash with LC_ALL=C.UTF-8 (typographic quotes normalised, scratch directory
 * rewritten to /tmp/ff). NOT covered, because the machines differ: the version banner, and an
 * inherited LD_PRELOAD (the real loader complains about a missing object).
 *
 * Measured against the commit before (worktree): 37 cases; the command did not exist, all 37 fall.
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
  ["stdbuf", "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf echo hi", "stdbuf: you must specify a buffering mode option\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf -oL echo hi", "hi\n[0]"],
  ["stdbuf -o0 -e0 -iL echo hi", "stdbuf: line buffering stdin is meaningless\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf -oX echo hi", "stdbuf: invalid mode 'X'\n[125]"],
  ["stdbuf -o 1K echo hi", "hi\n[0]"],
  ["stdbuf -o1KB echo hi", "hi\n[0]"],
  ["stdbuf -oL", "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf -oL nosuchcmd", "stdbuf: failed to run command 'nosuchcmd': No such file or directory\n[127]"],
  ["stdbuf -x echo", "stdbuf: invalid option -- 'x'\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf --output=L echo hi", "hi\n[0]"],
  ["stdbuf --output L echo hi", "hi\n[0]"],
  ["stdbuf --bogus", "stdbuf: unrecognized option '--bogus'\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf -oL -- echo hi", "hi\n[0]"],
  ["stdbuf -oL sh -c 'exit 3'", "[3]"],
  ["stdbuf -o99999999999999999999 echo hi", "stdbuf: invalid mode '99999999999999999999': Value too large for defined data type\n[125]"],
  ["stdbuf -o-1 echo hi", "stdbuf: invalid mode '-1'\n[125]"],
  ["stdbuf -o0 env | grep _STDBUF", "_STDBUF_O=0\n[0]"],
  ["stdbuf -oL printenv _STDBUF_O", "L\n[0]"],
  ["stdbuf -o 4 printenv _STDBUF_O", "4\n[0]"],
  ["stdbuf -i 4k printenv _STDBUF_I", "4096\n[0]"],
  ["stdbuf -e L printenv _STDBUF_E LD_PRELOAD | head -n 2", "L\n/usr/libexec/coreutils/libstdbuf.so\n[0]"],
  ["stdbuf -o1M printenv _STDBUF_O", "1048576\n[0]"],
  ["stdbuf -o1MB printenv _STDBUF_O", "1000000\n[0]"],
  ["stdbuf -o1G printenv _STDBUF_O", "1073741824\n[0]"],
  ["stdbuf -oL -eL -i0 printenv _STDBUF_I _STDBUF_O _STDBUF_E", "0\nL\nL\n[0]"],
  ["stdbuf -o 1 echo a b c", "a b c\n[0]"],
  ["stdbuf -oL cat nofile", "cat: nofile: No such file or directory\n[1]"],
  ["stdbuf -oL ls nofile", "ls: cannot access 'nofile': No such file or directory\n[2]"],
  ["stdbuf -iL -oL echo hi", "stdbuf: line buffering stdin is meaningless\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf -o1X echo hi", "stdbuf: invalid mode '1X'\n[125]"],
  ["stdbuf -o 1 -e", "stdbuf: option requires an argument -- 'e'\nTry 'stdbuf --help' for more information.\n[125]"],
  ["stdbuf --input=1 --error=2 printenv _STDBUF_I _STDBUF_E", "1\n2\n[0]"],
  ["stdbuf --inp=1 printenv _STDBUF_I", "1\n[0]"],
  ["stdbuf -oL -oM printenv _STDBUF_O", "1048576\n[0]"],
  ["stdbuf -oL echo hi | cat", "hi\n[0]"],
  ["stdbuf -oL stdbuf -eL printenv _STDBUF_O _STDBUF_E", "L\nL\n[0]"],
];

describe('stdbuf follows GNU stdbuf', () => {
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
