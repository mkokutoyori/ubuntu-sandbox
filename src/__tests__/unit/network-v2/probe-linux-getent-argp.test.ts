/*
 * getent parsed its line by hand: no argp errors (an unknown option answered with the full help and status 1 where glibc says
 * "invalid option -- 'x'" / "unrecognized option" + the 'Try' line with status 64), no -A, options not permuted after the database,
 * --usage and --help texts of another glibc, a database name folded to lower case, 'Unknown database' without its 'Try' line, no
 * validation of the database named in -s DB:CONFIG, and rpc entries one space short before the first alias. parseArgs now reads the
 * line with the shared getopt reader (permutation, abbreviations, bundles) and the texts captured from the real binary.
 *
 * Every expected string was produced by the real getent (glibc 2.39) of the dev container; the version, patch level and copyright year
 * are rewritten to the simulated distribution's glibc 2.35 (existing convention), the 'line 1: ' prefix of bash -c dropped.
 *
 * Measured against the commit before (worktree): 39 of 48 cases fall. The 9 that pass either way are the lookups and the -s forms that were already right
 * (passwd root, group root daemon, passwd nosuch, rpc ypbind, rpc nosuch, -s passwd:files, -s :files, -s group:files, --service=files) and
 * double as witnesses of the lab.
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
  ["getent", "getent: wrong number of arguments\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent -x", "getent: invalid option -- 'x'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent -h", "getent: invalid option -- 'h'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent --help", "Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -A, --no-addrconfig        do not filter out unsupported IPv4/IPv6 addresses\n                             (with ahosts*)\n  -i, --no-idn               disable IDN encoding\n  -s, --service=CONFIG       Service configuration to be used\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n\nMandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nSupported databases:\nahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups\nnetgroup networks passwd protocols rpc services shadow\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getent -?", "Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -A, --no-addrconfig        do not filter out unsupported IPv4/IPv6 addresses\n                             (with ahosts*)\n  -i, --no-idn               disable IDN encoding\n  -s, --service=CONFIG       Service configuration to be used\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n\nMandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nSupported databases:\nahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups\nnetgroup networks passwd protocols rpc services shadow\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getent --usage", "Usage: getent [-Ai?V] [-s CONFIG] [--no-addrconfig] [--no-idn]\n            [--service=CONFIG] [--help] [--usage] [--version]\n            database [key ...]\n[0]"],
  ["getent --usag", "Usage: getent [-Ai?V] [-s CONFIG] [--no-addrconfig] [--no-idn]\n            [--service=CONFIG] [--help] [--usage] [--version]\n            database [key ...]\n[0]"],
  ["getent -V", "getent (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\nThis is free software; see the source for copying conditions.  There is NO\nwarranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.\nWritten by Thorsten Kukuk.\n[0]"],
  ["getent --version", "getent (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\nThis is free software; see the source for copying conditions.  There is NO\nwarranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.\nWritten by Thorsten Kukuk.\n[0]"],
  ["getent --nosuch", "getent: unrecognized option '--nosuch'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent -s", "getent: option requires an argument -- 's'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent --service", "getent: option '--service' requires an argument\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent -s files", "getent: wrong number of arguments\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent -i", "getent: wrong number of arguments\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent -A", "getent: wrong number of arguments\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent passwd root --x", "getent: unrecognized option '--x'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent passwd -x", "getent: invalid option -- 'x'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent --no-idn=1 passwd root", "getent: option '--no-idn' doesn't allow an argument\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent -iA passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent -s passwd:files passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent -s nosuch:files passwd root", "getent: Unknown database name\n[1]"],
  ["getent -s publickey:files passwd root", "getent: Unknown database name\n[1]"],
  ["getent -s files:dns hosts localhost", "getent: Unknown database name\n[1]"],
  ["getent -s PASSWD:files passwd root", "getent: Unknown database name\n[1]"],
  ["getent -s :files passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent -s group:files passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent -sfiles passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent --service=files passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent --serv=files passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent passwd root -s files", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent -- passwd root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent passwd -- root", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent --nosuch passwd root", "getent: unrecognized option '--nosuch'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent --help passwd", "Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -A, --no-addrconfig        do not filter out unsupported IPv4/IPv6 addresses\n                             (with ahosts*)\n  -i, --no-idn               disable IDN encoding\n  -s, --service=CONFIG       Service configuration to be used\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n\nMandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nSupported databases:\nahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups\nnetgroup networks passwd protocols rpc services shadow\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getent passwd --help", "Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -A, --no-addrconfig        do not filter out unsupported IPv4/IPv6 addresses\n                             (with ahosts*)\n  -i, --no-idn               disable IDN encoding\n  -s, --service=CONFIG       Service configuration to be used\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n\nMandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nSupported databases:\nahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups\nnetgroup networks passwd protocols rpc services shadow\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getent -x --help", "getent: invalid option -- 'x'\nTry `getent --help' or `getent --usage' for more information.\n[64]"],
  ["getent --help -x", "Usage: getent [OPTION...] database [key ...]\nGet entries from administrative database.\n\n  -A, --no-addrconfig        do not filter out unsupported IPv4/IPv6 addresses\n                             (with ahosts*)\n  -i, --no-idn               disable IDN encoding\n  -s, --service=CONFIG       Service configuration to be used\n  -?, --help                 Give this help list\n      --usage                Give a short usage message\n  -V, --version              Print program version\n\nMandatory or optional arguments to long options are also mandatory or optional\nfor any corresponding short options.\n\nSupported databases:\nahosts ahostsv4 ahostsv6 aliases ethers group gshadow hosts initgroups\nnetgroup networks passwd protocols rpc services shadow\n\nFor bug reporting instructions, please see:\n<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.\n[0]"],
  ["getent --version -x", "getent (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\nThis is free software; see the source for copying conditions.  There is NO\nwarranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.\nWritten by Thorsten Kukuk.\n[0]"],
  ["getent PASSWD root", "Unknown database: PASSWD\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent Passwd root", "Unknown database: Passwd\nTry `getent --help' or `getent --usage' for more information.\n[1]"],
  ["getent nosuch 2>&1; echo $?", "Unknown database: nosuch\nTry `getent --help' or `getent --usage' for more information.\n1\n[0]"],
  ["getent passwd root 2>&1", "root:x:0:0:root:/root:/bin/bash\n[0]"],
  ["getent group root daemon", "root:x:0:\ndaemon:x:1:\n[0]"],
  ["getent passwd nosuch 2>&1; echo $?", "2\n[0]"],
  ["getent rpc portmapper", "portmapper      100000  portmap sunrpc rpcbind\n[0]"],
  ["getent rpc 100003", "nfs             100003  nfsprog\n[0]"],
  ["getent rpc ypbind", "ypbind          100007\n[0]"],
  ["getent rpc nosuch; echo $?", "2\n[0]"],
];

describe('getent against the real getent', () => {
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
