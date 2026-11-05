/*
 * uptime refused an unknown option with a one-line message and status 0, accepted -h and -V as the plain report, took operands, and let -p win over -s.
 * It now reads its line like procps uptime.c (getopt 'psVh' with the long names and their abbreviations): -h prints the usage and exits at once,
 * -V the version and exits at once, an invalid option or a stray operand prints the getopt diagnostic then the usage on stderr with status 1, and
 * -s wins over -p.
 *
 * Every expected string was produced by the real uptime of procps-ng 4.0.4 of the dev container; the version is rewritten to the simulated
 * distribution's 3.3.17. Clock-dependent output is counted with grep -c, never pinned.
 *
 * Measured against the commit before (worktree): 20 of 22 cases fall. The 2 that pass either way ("uptime -s" and "uptime" counted with grep -c) are witnesses of the lab and of the
 * default report.
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
  ["uptime -x", "uptime: invalid option -- 'x'\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime --nosuch", "uptime: unrecognized option '--nosuch'\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime extra", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime -h", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[0]"],
  ["uptime --help", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[0]"],
  ["uptime -V", "uptime from procps-ng 3.3.17\n[0]"],
  ["uptime --version", "uptime from procps-ng 3.3.17\n[0]"],
  ["uptime -p extra", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime -pV", "uptime from procps-ng 3.3.17\n[0]"],
  ["uptime -hV", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[0]"],
  ["uptime -- -p", "\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime -p -x", "uptime: invalid option -- 'x'\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime -px", "uptime: invalid option -- 'x'\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime --pretty=1", "uptime: option '--pretty' doesn't allow an argument\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
  ["uptime --pret | grep -c '^up '", "1\n[0]"],
  ["uptime -s | grep -c '^20'", "1\n[0]"],
  ["uptime -ps | grep -c '^20'", "1\n[0]"],
  ["uptime -sp | grep -c '^20'", "1\n[0]"],
  ["uptime | grep -c 'load average'", "1\n[0]"],
  ["uptime -- | grep -c 'load average'", "1\n[0]"],
  ["uptime -Vx", "uptime from procps-ng 3.3.17\n[0]"],
  ["uptime -xV", "uptime: invalid option -- 'x'\n\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).\n[1]"],
];

describe('uptime against the real uptime', () => {
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
