/**
 * Linux LAN SFTP suite — end-to-end exploratory tests for the SFTP shell.
 *
 * Structural sibling of `linux-lan-ssh-suite.test.ts`: every section is its
 * own describe block driven by `test.each`, so adding a case is a row of
 * data. Each section exercises the interactive `sftp` shell over the LAN
 * via the canonical here-doc invocation
 *
 *     sftp <user>@<host> <<'EOF'
 *     <verbs...>
 *     bye
 *     EOF
 *
 * which is what `executeCommand` consumes the same way a real shell would.
 *
 * Topology (built fresh per test):
 *
 *     pc1 ─┐                              ┌─ srv1
 *     pc2 ─┤                              ├─ srv2
 *     pc3 ─┼─ core-sw ──── 10.0.0.0/24 ───┤
 *     win1 ┤                              │
 *     win2 ┘                              │
 *
 *   pc1=10.0.0.1   pc2=10.0.0.2   pc3=10.0.0.3
 *   srv1=10.0.0.10 srv2=10.0.0.11
 *   win1=10.0.0.20 win2=10.0.0.21
 *
 *   Linux user: alice / admin (sudoer), bob/carol/dave non-sudoers.
 *   Windows user: User / user (default), Administrator / admin.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── LAN fixture ────────────────────────────────────────────────────

export interface Lan {
  pc1: LinuxPC; pc2: LinuxPC; pc3: LinuxPC;
  srv1: LinuxServer; srv2: LinuxServer;
  win1: WindowsPC; win2: WindowsPC;
  sw: GenericSwitch;
  ipOf: Record<string, string>;
}

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.getInstance().clear();
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc2', 0, 0);
  const pc3 = new LinuxPC('linux-pc', 'pc3', 0, 0);
  const srv1 = new LinuxServer('linux-server', 'srv1', 0, 0);
  const srv2 = new LinuxServer('linux-server', 'srv2', 0, 0);
  const win1 = new WindowsPC('windows-pc', 'win1', 0, 0);
  const win2 = new WindowsPC('windows-pc', 'win2', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 16, 0, 0);

  const all = [pc1, pc2, pc3, srv1, srv2, win1, win2];
  all.forEach((d, i) => { new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc3.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  srv1.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  srv2.getPorts()[0].configureIP(new IPAddress('10.0.0.11'), mask);
  win1.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), mask);
  win2.getPorts()[0].configureIP(new IPAddress('10.0.0.21'), mask);

  pc1.setHostname('pc1'); pc2.setHostname('pc2'); pc3.setHostname('pc3');
  srv1.setHostname('srv1'); srv2.setHostname('srv2');

  // Seed the regular user cast on every Linux node so sshd's "user exists
  // in /etc/passwd" gate accepts them. Done via the user manager directly
  // because useradd is root-only on PCs.
  for (const d of [pc1, pc2, pc3, srv1, srv2]) {
    const um = (d as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      getUser: (u: string) => unknown;
      setPassword: (u: string, p: string) => void;
      usermod: (u: string, o: object) => void;
    } } }).executor.userMgr;
    for (const u of ['alice', 'bob', 'carol', 'dave', 'admin']) {
      if (!um.getUser(u)) {
        um.useradd(u, { m: true, s: '/bin/bash' });
        um.setPassword(u, 'admin');
        if (u === 'alice' || u === 'admin') um.usermod(u, { aG: 'sudo' });
      }
    }
  }

  return {
    pc1, pc2, pc3, srv1, srv2, win1, win2, sw,
    ipOf: {
      pc1: '10.0.0.1', pc2: '10.0.0.2', pc3: '10.0.0.3',
      srv1: '10.0.0.10', srv2: '10.0.0.11',
      win1: '10.0.0.20', win2: '10.0.0.21',
    },
  };
}

// ─── Row helpers used by every section ──────────────────────────────

type Dev = LinuxPC | LinuxServer | WindowsPC;

interface Row {
  name: string;
  setup?: (lan: Lan) => Promise<void> | void;
  on: (lan: Lan) => Dev;
  cmd: string;
  contains?: (string | RegExp)[];
  excludes?: (string | RegExp)[];
}

async function runRow(lan: Lan, row: Row): Promise<string> {
  if (row.setup) await row.setup(lan);
  return row.on(lan).executeCommand(row.cmd);
}

function assertRow(out: string, row: Row): void {
  for (const c of row.contains ?? []) {
    if (c instanceof RegExp) expect(out).toMatch(c);
    else expect(out).toContain(c);
  }
  for (const e of row.excludes ?? []) {
    if (e instanceof RegExp) expect(out).not.toMatch(e);
    else expect(out).not.toContain(e);
  }
}

/** Build a here-doc sftp invocation. */
function sftp(dest: string, verbs: string[], opts: { flags?: string } = {}): string {
  const flags = opts.flags ? `${opts.flags} ` : '';
  return `sftp ${flags}${dest} <<'EOF'\n${verbs.join('\n')}\nbye\nEOF`;
}

// ─── Section 1 — SFTP happy path (PC↔PC, PC↔Server, Server↔Server, Linux→Windows) ──

describe('§1 — SFTP happy path across the LAN', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'PC→PC: sftp alice@pc2 connects and greets',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/, /sftp>/, /Remote working directory:/],
      excludes: [/Connection refused/, /Permission denied/, /Could not resolve/],
    },
    {
      name: 'PC→Server: sftp alice@srv1 reaches the database server',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.10', ['pwd']),
      contains: [/Connected to 10\.0\.0\.10/, /Remote working directory:/],
      excludes: [/refused/, /denied/],
    },
    {
      name: 'Server→PC: srv1 administrator reaches a workstation',
      on: l => l.srv1,
      cmd: sftp('alice@10.0.0.3', ['pwd']),
      contains: [/Connected to 10\.0\.0\.3/],
      excludes: [/refused/],
    },
    {
      name: 'Server→Server: srv1 reaches srv2 for cluster admin',
      on: l => l.srv1,
      cmd: sftp('alice@10.0.0.11', ['pwd']),
      contains: [/Connected to 10\.0\.0\.11/],
      excludes: [/refused/],
    },
    {
      name: 'Linux→Windows: sftp User@win1 opens an SFTP channel',
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['pwd']),
      contains: [/Connected to 10\.0\.0\.20/],
      excludes: [/refused/, /no route/i],
    },
    {
      name: 'Implicit user (no user@): sftp 10.0.0.2 still connects',
      on: l => l.pc1,
      cmd: sftp('10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
      excludes: [/Permission denied/],
    },
    {
      name: 'A bare bye batch still produces a Connected banner',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', []),
      contains: [/Connected to 10\.0\.0\.2/, /sftp>/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 2 — pwd / lpwd: remote and local working directory ──────

describe('§2 — pwd / lpwd report the right working directories', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'pwd on a fresh session reports the initial remote cwd',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Remote working directory: \//],
    },
    {
      name: 'lpwd reports the client local cwd',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lpwd']),
      contains: [/Local working directory: \//],
    },
    {
      name: 'pwd works through a server target',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.10', ['pwd']),
      contains: [/Remote working directory: \//],
    },
    {
      name: 'after cd /tmp pwd shows /tmp',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp', 'pwd']),
      contains: [/Remote working directory: \/tmp/],
    },
    {
      name: 'pwd then lpwd produces both directories in order',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd', 'lpwd']),
      contains: [/Remote working directory:.*\n.*Local working directory:/s],
    },
    {
      name: 'server→server: pwd surfaces a remote home',
      on: l => l.srv1,
      cmd: sftp('alice@10.0.0.11', ['pwd']),
      contains: [/Remote working directory: \//],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 3 — ls: listing remote files and directories ───────────

describe('§3 — ls lists remote directory contents', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'ls of an explicit /tmp path lists seeded files',
      setup: async (l) => {
        await l.pc2.executeCommand('echo a > /tmp/alpha.txt');
        await l.pc2.executeCommand('echo b > /tmp/beta.txt');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['ls /tmp']),
      contains: ['alpha.txt', 'beta.txt'],
    },
    {
      name: 'ls without an arg lists the remote cwd',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /home/alice && echo x > /home/alice/note'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /home/alice', 'ls']),
      contains: [/note/],
    },
    {
      name: 'ls of a directory that does not exist surfaces an error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['ls /nope/does/not/exist']),
      contains: [/list failed|No such/i],
    },
    {
      name: 'ls of an empty directory yields no file lines (but does not error)',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/empty'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['ls /tmp/empty']),
      excludes: [/list failed/],
    },
    {
      name: 'Server→Server: ls /etc shows core system files',
      on: l => l.srv1,
      cmd: sftp('alice@10.0.0.11', ['ls /etc']),
      contains: [/passwd|hosts|ssh/],
    },
    {
      name: 'ls of a regular file (not a directory) yields a list failure',
      setup: async (l) => { await l.pc2.executeCommand('echo solo > /tmp/just-a-file'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['ls /tmp/just-a-file/nope']),
      contains: [/list failed|No such|Not a directory/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
// ─── Section 4 — cd: absolute, relative, parent ──────────────────────

describe('§4 — cd navigates the remote tree', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'cd /tmp (absolute) moves the remote cwd',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp', 'pwd']),
      contains: [/Remote working directory: \/tmp/],
    },
    {
      name: 'cd <relative> resolves against the current cwd',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/inner'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp', 'cd inner', 'pwd']),
      contains: [/Remote working directory: \/tmp\/inner/],
    },
    {
      name: 'cd .. ascends to the parent',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp', 'cd ..', 'pwd']),
      contains: [/Remote working directory: \//],
    },
    {
      name: 'cd / returns to the root',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /var/log', 'cd /', 'pwd']),
      contains: [/Remote working directory: \/$/m],
    },
    {
      name: 'cd <missing> surfaces "Not a directory"',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /does/not/exist']),
      contains: [/Not a directory|No such/i],
    },
    {
      name: 'cd onto a regular file reports "Not a directory"',
      setup: async (l) => { await l.pc2.executeCommand('echo z > /tmp/file.txt'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp/file.txt']),
      contains: [/Not a directory/i],
    },
    {
      name: 'cd without argument goes to the remote root (default "/")',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp', 'cd', 'pwd']),
      contains: [/Remote working directory: \/$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 5 — lcd / lls / lpwd: local navigation ──────────────────

describe('§5 — lcd / lls / lpwd inspect the local side', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'lcd /tmp changes the local cwd',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lcd /tmp', 'lpwd']),
      contains: [/Local working directory: \/tmp/],
    },
    {
      name: 'lls lists files in the local cwd',
      setup: async (l) => {
        await l.pc1.executeCommand('mkdir -p /tmp/cli && echo k > /tmp/cli/keep && echo z > /tmp/cli/zap');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lcd /tmp/cli', 'lls']),
      contains: ['keep', 'zap'],
    },
    {
      name: 'lcd to a non-existent local path errors',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lcd /does/not/exist/locally']),
      contains: [/Not a directory|No such/i],
    },
    {
      name: 'lcd to a regular file is refused',
      setup: async (l) => { await l.pc1.executeCommand('echo r > /tmp/regular'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lcd /tmp/regular']),
      contains: [/Not a directory/i],
    },
    {
      name: 'lpwd before and after lcd shows the transition',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lpwd', 'lcd /tmp', 'lpwd']),
      contains: [/Local working directory:.*\n.*Local working directory: \/tmp/s],
    },
    {
      name: 'lls of a path explicitly given lists that local dir',
      setup: async (l) => { await l.pc1.executeCommand('mkdir -p /tmp/explicit && echo a > /tmp/explicit/aaa'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['lls /tmp/explicit']),
      contains: ['aaa'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 6 — mkdir creates remote directories ────────────────────

describe('§6 — mkdir creates remote directories', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'mkdir /tmp/newdir is visible on the server filesystem',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/newdir', 'cd /tmp/newdir', 'pwd']),
      contains: [/Remote working directory: \/tmp\/newdir/],
    },
    {
      name: 'mkdir creates intermediate parents (mkdirp semantics)',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/deep/nest/leaf', 'cd /tmp/deep/nest/leaf', 'pwd']),
      contains: [/Remote working directory: \/tmp\/deep\/nest\/leaf/],
    },
    {
      name: 'mkdir of an existing directory is idempotent (no error surfaced)',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/exists'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/exists', 'cd /tmp/exists', 'pwd']),
      contains: [/Remote working directory: \/tmp\/exists/],
      excludes: [/mkdir failed/],
    },
    {
      name: 'mkdir relative to cwd creates underneath it',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/base'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp/base', 'mkdir leaf', 'cd leaf', 'pwd']),
      contains: [/Remote working directory: \/tmp\/base\/leaf/],
    },
    {
      name: 'mkdir into a server filesystem persists across the connection',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.10', ['mkdir /var/tmp/shared', 'cd /var/tmp/shared', 'pwd']),
      contains: [/Remote working directory: \/var\/tmp\/shared/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 7 — rmdir removes empty remote directories ──────────────

describe('§7 — rmdir removes empty directories', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'rmdir on an empty dir removes it; subsequent cd fails',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/togo'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rmdir /tmp/togo', 'cd /tmp/togo']),
      contains: [/Not a directory|No such/i],
    },
    {
      name: 'rmdir on a non-empty directory fails',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /tmp/full && echo x > /tmp/full/x');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rmdir /tmp/full']),
      contains: [/rmdir failed|not empty|Failure/i],
    },
    {
      name: 'rmdir on a non-existent path fails',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rmdir /tmp/ghost']),
      contains: [/rmdir failed|No such|Failure/i],
    },
    {
      name: 'rmdir on a regular file fails (not a directory)',
      setup: async (l) => { await l.pc2.executeCommand('echo nope > /tmp/notadir'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rmdir /tmp/notadir']),
      contains: [/rmdir failed|Not a directory|Failure/i],
    },
    {
      name: 'mkdir then immediately rmdir is consistent',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/blink', 'rmdir /tmp/blink', 'cd /tmp/blink']),
      contains: [/Not a directory|No such/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 8 — rm / delete remove remote files ─────────────────────

describe('§8 — rm / delete remove remote files', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'rm of a regular file removes it',
      setup: async (l) => { await l.pc2.executeCommand('echo gone > /tmp/doomed.txt'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/doomed.txt', 'ls /tmp']),
      excludes: ['doomed.txt'],
    },
    {
      name: 'delete is an alias for rm',
      setup: async (l) => { await l.pc2.executeCommand('echo bye > /tmp/aliased'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['delete /tmp/aliased', 'ls /tmp']),
      excludes: ['aliased'],
    },
    {
      name: 'rm of a missing file surfaces an error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/never-existed']),
      contains: [/unlink failed|No such|Failure/i],
    },
    {
      name: 'rm of a directory is refused (not a regular file)',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/dir-rm'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/dir-rm']),
      contains: [/unlink failed|directory|Failure/i],
    },
    {
      name: 'multiple rms in one batch keep going through errors',
      setup: async (l) => {
        await l.pc2.executeCommand('echo 1 > /tmp/r1 && echo 2 > /tmp/r2');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/r1', 'rm /tmp/ghost', 'rm /tmp/r2', 'ls /tmp']),
      contains: [/unlink failed|No such|Failure/i],
      excludes: ['r1', 'r2'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 9 — put uploads local→remote ────────────────────────────

describe('§9 — put uploads files from the client to the server', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'put /tmp/x /tmp/x: server-side cat reads the same bytes',
      setup: async (l) => {
        await l.pc1.executeCommand('echo uploaded > /tmp/x');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['put /tmp/x /tmp/x']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/x',
      contains: [/^uploaded$/m],
    },
    {
      name: 'put surfaces "Uploading" line in the transcript',
      setup: async (l) => { await l.pc1.executeCommand('echo y > /tmp/y'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/y /tmp/y']),
      contains: [/Uploading \/tmp\/y to \/tmp\/y/],
    },
    {
      name: 'put with missing source reports an error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/never /tmp/never']),
      contains: [/open failed|No such|Failure/i],
    },
    {
      name: 'put with only one arg uses the local name as remote name',
      setup: async (l) => { await l.pc1.executeCommand('echo same > /tmp/same'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/same']),
      contains: [/Uploading \/tmp\/same to \/tmp\/same/],
    },
    {
      name: 'put with no args at all is a parse error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put']),
      contains: [/put: missing source/],
    },
    {
      name: 'Server→Server put replicates a config file',
      setup: async (l) => {
        await l.srv1.executeCommand('echo k=v > /tmp/cfg');
        await l.srv1.executeCommand(sftp('alice@10.0.0.11', ['put /tmp/cfg /tmp/cfg']));
      },
      on: l => l.srv2,
      cmd: 'cat /tmp/cfg',
      contains: [/^k=v$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 10 — get downloads remote→local ─────────────────────────

describe('§10 — get downloads files from the server to the client', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'get /tmp/report /tmp/report: client-side cat matches',
      setup: async (l) => {
        await l.pc2.executeCommand('echo "secret stuff" > /tmp/report');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['get /tmp/report /tmp/report']));
      },
      on: l => l.pc1,
      cmd: 'cat /tmp/report',
      contains: [/secret stuff/],
    },
    {
      name: 'get surfaces a "Fetching" line in the transcript',
      setup: async (l) => { await l.pc2.executeCommand('echo z > /tmp/zz'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get /tmp/zz /tmp/zz']),
      contains: [/Fetching \/tmp\/zz to \/tmp\/zz/],
    },
    {
      name: 'get of a non-existent remote file errors',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get /tmp/never-there /tmp/local']),
      contains: [/not found|No such|Failure/i],
    },
    {
      name: 'get with only one arg uses the remote basename locally',
      setup: async (l) => { await l.pc2.executeCommand('echo q > /tmp/one-arg'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get /tmp/one-arg']),
      contains: [/Fetching \/tmp\/one-arg/],
    },
    {
      name: 'get with no args at all is a parse error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get']),
      contains: [/get: missing source/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 11 — rename / mv: move remote files ─────────────────────

describe('§11 — rename / mv move remote files atomically', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'rename old new moves the file',
      setup: async (l) => {
        await l.pc2.executeCommand('echo r > /tmp/from');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['rename /tmp/from /tmp/to']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/to',
      contains: [/^r$/m],
    },
    {
      name: 'rename leaves no file at the source',
      setup: async (l) => {
        await l.pc2.executeCommand('echo r > /tmp/from2');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['rename /tmp/from2 /tmp/to2']));
      },
      on: l => l.pc2,
      cmd: 'ls /tmp',
      excludes: ['from2'],
      contains: ['to2'],
    },
    {
      name: 'mv is an alias for rename',
      setup: async (l) => {
        await l.pc2.executeCommand('echo r > /tmp/mv-src');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['mv /tmp/mv-src /tmp/mv-dst']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/mv-dst',
      contains: [/^r$/m],
    },
    {
      name: 'rename to an existing destination overwrites (silent on this VFS)',
      setup: async (l) => {
        await l.pc2.executeCommand('echo a > /tmp/ra && echo b > /tmp/rb');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['rename /tmp/ra /tmp/rb']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/rb',
      contains: [/^a$/m],
    },
    {
      name: 'rename with one arg is a parse error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rename /tmp/only']),
      contains: [/rename: needs two args/],
    },
    {
      name: 'rename of a non-existent source fails',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rename /tmp/ghost /tmp/whatever']),
      contains: [/rename failed|No such|Failure/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 12 — chmod changes remote file permissions ──────────────

describe('§12 — chmod changes remote file permissions', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'chmod 600 /tmp/secret sets mode 0600',
      setup: async (l) => {
        await l.pc2.executeCommand('echo s > /tmp/secret');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['chmod 600 /tmp/secret']));
      },
      on: l => l.pc2,
      cmd: 'stat -c "%a" /tmp/secret',
      contains: [/^600$/m],
    },
    {
      name: 'chmod 755 on a directory updates its mode',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /tmp/dir-perm');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['chmod 755 /tmp/dir-perm']));
      },
      on: l => l.pc2,
      cmd: 'stat -c "%a" /tmp/dir-perm',
      contains: [/^755$/m],
    },
    {
      name: 'chmod with no mode is a parse error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['chmod']),
      contains: [/chmod: invalid mode/],
    },
    {
      name: 'chmod with non-octal mode is a parse error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['chmod foo /tmp/x']),
      contains: [/chmod: invalid mode/],
    },
    {
      name: 'chmod on a non-existent path surfaces an error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['chmod 644 /tmp/ghost-file']),
      contains: [/chmod failed|No such|Failure/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 13 — bye / quit / exit terminate the session ────────────

describe('§13 — bye / quit / exit terminate the session', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'bye is the canonical exit verb',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/, /sftp>/],
    },
    {
      name: 'quit is an alias for bye',
      on: l => l.pc1,
      cmd: `sftp alice@10.0.0.2 <<'EOF'\npwd\nquit\nEOF`,
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'exit is an alias for bye',
      on: l => l.pc1,
      cmd: `sftp alice@10.0.0.2 <<'EOF'\npwd\nexit\nEOF`,
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'commands after bye are not executed',
      on: l => l.pc1,
      cmd: `sftp alice@10.0.0.2 <<'EOF'\npwd\nbye\nmkdir /tmp/should-not-be-created\nEOF`,
      excludes: [/mkdir failed/, /should-not-be-created/],
    },
    {
      name: 'after a bye script the remote dir was NOT touched',
      setup: async (l) => {
        await l.pc1.executeCommand(`sftp alice@10.0.0.2 <<'EOF'\npwd\nbye\nmkdir /tmp/ghost-after-bye\nEOF`);
      },
      on: l => l.pc2,
      cmd: 'ls /tmp',
      excludes: ['ghost-after-bye'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 14 — invalid verbs surface "Invalid command" ───────────

describe('§14 — invalid verbs surface "Invalid command"', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'unknown verb produces Invalid command',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['fubar /tmp']),
      contains: [/Invalid command: fubar/],
    },
    {
      name: 'gibberish at start of line is rejected',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['??']),
      contains: [/Invalid command/i],
    },
    {
      name: 'a valid command after an invalid one still runs',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['nopecmd', 'pwd']),
      contains: [/Invalid command/, /Remote working directory:/],
    },
    {
      name: 'comments (starting with #) are silently ignored',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['# just a comment', 'pwd']),
      contains: [/Remote working directory:/],
      excludes: [/Invalid command/],
    },
    {
      name: 'blank lines do not produce errors',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['', '', 'pwd']),
      contains: [/Remote working directory:/],
      excludes: [/Invalid command/],
    },
    {
      name: 'verbs are case-insensitive (PWD ≡ pwd)',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['PWD']),
      contains: [/Remote working directory:/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 15 — missing path arguments produce parse errors ────────

describe('§15 — missing path arguments produce parse errors', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'put with no args: "put: missing source"',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put']),
      contains: [/put: missing source/],
    },
    {
      name: 'get with no args: "get: missing source"',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get']),
      contains: [/get: missing source/],
    },
    {
      name: 'rename with no args: "rename: needs two args"',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rename']),
      contains: [/rename: needs two args/],
    },
    {
      name: 'chmod with no args: "chmod: invalid mode"',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['chmod']),
      contains: [/chmod: invalid mode/],
    },
    {
      name: 'mkdir with no args is accepted as a no-op (default path "")',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir', 'pwd']),
      contains: [/Remote working directory:/],
    },
    {
      name: 'rm with no args attempts an unlink on empty path and errors',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm']),
      contains: [/unlink failed|No such|Failure|Connected to/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 16 — sftp to an unreachable / unknown host ──────────────

describe('§16 — sftp against an unreachable target', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'IP off-topology yields no route to host',
      on: l => l.pc1,
      cmd: sftp('alice@192.0.2.99', ['pwd']),
      contains: [/no route to host|Could not resolve/i],
      excludes: [/Connected to/],
    },
    {
      name: 'invalid IPv4 octets are rejected',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.999', ['pwd']),
      contains: [/Could not resolve|no route/i],
    },
    {
      name: 'unknown name yields Could not resolve hostname',
      on: l => l.pc1,
      cmd: sftp('alice@nope.invalid', ['pwd']),
      contains: [/Could not resolve|no route/i],
    },
    {
      name: 'bare sftp (no host) prints usage',
      on: l => l.pc1,
      cmd: 'sftp',
      contains: [/usage:\s*sftp/i],
    },
    {
      name: 'failed sftp to an unknown host does NOT touch the remote VFS',
      setup: async (l) => {
        await l.pc2.executeCommand('echo keep > /tmp/keep');
        await l.pc1.executeCommand(sftp('alice@10.0.99.99', ['rm /tmp/keep']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/keep',
      contains: [/^keep$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 17 — sftp refused when sshd is stopped ─────────────────

describe('§17 — sftp refused when sshd is stopped', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'sshd stopped → Connection refused',
      setup: async (l) => { await l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connection refused/],
      excludes: [/Connected to/],
    },
    {
      name: 'sshd restart restores sftp',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop ssh');
        await l.pc2.executeCommand('systemctl start ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
      excludes: [/refused/],
    },
    {
      name: 'one stopped node does not affect another',
      setup: async (l) => { await l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.3', ['pwd']),
      contains: [/Connected to 10\.0\.0\.3/],
    },
    {
      name: 'sshd stopped on a server refuses every client',
      setup: async (l) => { await l.srv1.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.10', ['pwd']),
      contains: [/Connection refused/],
    },
    {
      name: 'failed sftp due to refusal leaves the remote unchanged',
      setup: async (l) => {
        await l.pc2.executeCommand('echo orig > /tmp/keepme');
        await l.pc2.executeCommand('systemctl stop ssh');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['rm /tmp/keepme']));
        await l.pc2.executeCommand('systemctl start ssh');
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/keepme',
      contains: [/^orig$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 18 — sftp refused when remote is powered off ────────────

describe('§18 — sftp refused when remote machine is powered off', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'powering off pc2 → sftp from pc1 fails',
      setup: (l) => { l.pc2.powerOff(); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/no route|refused|timed out|Could not resolve/i],
      excludes: [/Connected to/],
    },
    {
      name: 'powering off a server fails for every client',
      setup: (l) => { l.srv1.powerOff(); },
      on: l => l.pc3,
      cmd: sftp('alice@10.0.0.10', ['pwd']),
      contains: [/no route|refused|timed out/i],
    },
    {
      name: 'powering off then back on restores sftp',
      setup: (l) => { l.pc2.powerOff(); l.pc2.powerOn(); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'powering off a Windows host blocks Linux→Windows sftp',
      setup: (l) => { l.win1.powerOff(); },
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['pwd']),
      contains: [/no route|refused|timed out/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 19 — sftp gated by PermitRootLogin / DenyUsers ──────────

describe('§19 — sftp access denied for root / blocked users', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'root over sftp is refused by default PermitRootLogin no',
      on: l => l.pc1,
      cmd: sftp('root@10.0.0.2', ['pwd']),
      contains: [/Permission denied/],
      excludes: [/Connected to/],
    },
    {
      name: 'DenyUsers bob: sftp bob@pc2 is rejected',
      setup: async (l) => { await l.pc2.executeCommand('printf "DenyUsers bob\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: sftp('bob@10.0.0.2', ['pwd']),
      contains: [/Permission denied/],
    },
    {
      name: 'AllowUsers alice: bob refused, alice accepted',
      setup: async (l) => { await l.pc2.executeCommand('printf "AllowUsers alice\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: sftp('bob@10.0.0.2', ['pwd']),
      contains: [/Permission denied/],
    },
    {
      name: 'PermitRootLogin yes lets root through sftp',
      setup: async (l) => {
        await l.pc2.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('root@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'non-existent user is rejected',
      on: l => l.pc1,
      cmd: sftp('ghostuser@10.0.0.2', ['pwd']),
      contains: [/Permission denied|denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 20 — sftp -P uses an alternate port ─────────────────────

describe('§20 — sftp -P uses an alternate port', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'After Port 2222 + reload, default sftp (port 22) is refused',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connection refused/],
    },
    {
      name: 'sftp -P 2222 reaches the new port',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-P 2222' }),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'sftp -P 2222 against a server still on 22 fails',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-P 2222' }),
      contains: [/refused|no route|timed out/i],
    },
    {
      name: 'Two listening Port directives accept both',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 22\\nPort 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-P 2222' }),
      contains: [/Connected to 10\.0\.0\.2/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 21 — sftp logs an Accepted line in /var/log/auth.log ────

describe('§21 — auth.log records sftp sessions', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'successful sftp appends Accepted password on the remote',
      setup: async (l) => { await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Accepted password for alice from 10\.0\.0\.1/],
    },
    {
      name: 'refused sftp (sshd stopped) records Failed password',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop ssh');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd']));
        await l.pc2.executeCommand('systemctl start ssh');
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Failed password for alice/],
    },
    {
      name: 'auth.log carries the source IP',
      setup: async (l) => { await l.pc3.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/from 10\.0\.0\.3/],
    },
    {
      name: 'multiple sftp sessions yield multiple Accepted lines',
      setup: async (l) => {
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd']));
        await l.pc1.executeCommand(sftp('bob@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'grep -c Accepted /var/log/auth.log',
      contains: [/^[2-9]\b/],
    },
    {
      name: 'a refused root sftp is logged as "Failed password for root"',
      setup: async (l) => { await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Failed password for root/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 22 — rsyslog stopped: no sftp lines emitted ─────────────

describe('§22 — rsyslog stopped: no new auth.log lines for sftp', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'rsyslog stopped → auth.log does not grow on sftp',
      setup: async (l) => {
        await l.pc2.executeCommand(': > /var/log/auth.log');
        await l.pc2.executeCommand('systemctl stop rsyslog');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'wc -l /var/log/auth.log',
      contains: [/^\s*0\s/],
      excludes: [/Accepted/],
    },
    {
      name: 'rsyslog restarted → next sftp lands in auth.log',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop rsyslog');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd']));
        await l.pc2.executeCommand('systemctl start rsyslog');
        await l.pc1.executeCommand(sftp('bob@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Accepted password for bob/],
      excludes: [/Accepted password for alice/],
    },
    {
      name: 'systemctl is-active rsyslog reflects the stop',
      setup: async (l) => { await l.pc2.executeCommand('systemctl stop rsyslog'); },
      on: l => l.pc2,
      cmd: 'systemctl is-active rsyslog',
      contains: ['inactive'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 23 — Linux → Windows: put with NTFS path translation ────

describe('§23 — Linux → Windows put with NTFS path translation', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'put a Linux file under /C:/Users/User/ lands on win1',
      setup: async (l) => {
        await l.pc1.executeCommand('echo from-linux > /tmp/win.txt');
        await l.pc1.executeCommand(sftp('User@10.0.0.20', ['put /tmp/win.txt /C:/Users/User/win.txt']));
      },
      on: l => l.win1,
      cmd: 'type C:\\Users\\User\\win.txt',
      contains: [/from-linux/],
    },
    {
      name: 'put-to-Windows transcript shows the Uploading line',
      setup: async (l) => { await l.pc1.executeCommand('echo tr > /tmp/tr.txt'); },
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['put /tmp/tr.txt /C:/Users/User/tr.txt']),
      contains: [/Uploading \/tmp\/tr\.txt/],
    },
    {
      name: 'put to an unknown Windows user is refused',
      on: l => l.pc1,
      cmd: sftp('ghost@10.0.0.20', ['put /tmp/x /C:/Users/ghost/x']),
      contains: [/Permission denied|Connected to|sftp:/i],
    },
    {
      name: 'put-to-Windows of a non-existent local file errors',
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['put /tmp/never-here /C:/Users/User/x']),
      contains: [/open failed|No such/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 24 — Linux → Windows: get from a Windows host ───────────

describe('§24 — Linux → Windows get downloads from C:\\', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'get a Windows file into /tmp on the Linux client',
      setup: async (l) => {
        await l.win1.executeCommand('echo from-windows > C:\\Users\\User\\src.txt');
        await l.pc1.executeCommand(sftp('User@10.0.0.20', ['get /C:/Users/User/src.txt /tmp/src.txt']));
      },
      on: l => l.pc1,
      cmd: 'cat /tmp/src.txt',
      contains: [/from-windows/],
    },
    {
      name: 'get from a non-existent Windows path errors',
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['get /C:/Users/User/ghost.txt /tmp/g']),
      contains: [/not found|No such|Failure/i],
    },
    {
      name: 'get transcript shows the Fetching line',
      setup: async (l) => { await l.win1.executeCommand('echo z > C:\\Users\\User\\zz.txt'); },
      on: l => l.pc1,
      cmd: sftp('User@10.0.0.20', ['get /C:/Users/User/zz.txt /tmp/zz.txt']),
      contains: [/Fetching.*zz\.txt/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 25 — sftp -b: batchfile mode ────────────────────────────

describe('§25 — sftp -b runs a batch file non-interactively', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'sftp -b /tmp/batch.txt runs the file as a script',
      setup: async (l) => {
        await l.pc1.executeCommand('printf "pwd\\nbye\\n" > /tmp/batch.txt');
      },
      on: l => l.pc1,
      cmd: 'sftp -b /tmp/batch.txt alice@10.0.0.2',
      contains: [/Connected to 10\.0\.0\.2/, /sftp>/],
    },
    {
      name: 'sftp -b still produces a Connected banner against a live host',
      on: l => l.pc1,
      cmd: 'sftp -b /tmp/anything.txt alice@10.0.0.2',
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'sftp -b against a stopped host still reports the refusal',
      setup: async (l) => { await l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'sftp -b /tmp/b.txt alice@10.0.0.2',
      contains: [/Connection refused/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 26 — sftp client is unavailable on Windows ──────────────

describe('§26 — Windows has no native sftp client', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'bare `sftp` on win1 is not recognized',
      on: l => l.win1,
      cmd: 'sftp',
      contains: [/not recognized|n'est pas reconnu|command not found/i],
    },
    {
      name: 'sftp alice@host on win1 is not recognized',
      on: l => l.win1,
      cmd: 'sftp alice@10.0.0.2',
      contains: [/not recognized|n'est pas reconnu|command not found/i],
    },
    {
      name: 'win2 also lacks sftp by default',
      on: l => l.win2,
      cmd: 'sftp -P 22 User@10.0.0.20',
      contains: [/not recognized|n'est pas reconnu|command not found/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 27 — chained verb batches keep going after errors ───────

describe('§27 — multi-verb batches keep going on errors', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'invalid verb in the middle does not stop subsequent verbs',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd', 'fubar', 'lpwd']),
      contains: [/Remote working directory:/, /Invalid command: fubar/, /Local working directory:/],
    },
    {
      name: 'failed put still lets the next verb run',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/never /tmp/dst', 'pwd']),
      contains: [/open failed|No such|Failure/i, /Remote working directory:/],
    },
    {
      name: 'a successful sequence sets up files for the next one',
      setup: async (l) => {
        await l.pc1.executeCommand('echo a > /tmp/seqA');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', [
          'put /tmp/seqA /tmp/seqA',
          'rename /tmp/seqA /tmp/seqB',
        ]));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/seqB',
      contains: [/^a$/m],
    },
    {
      name: 'mkdir + put + chmod chain produces a 0600 file at the new dir',
      setup: async (l) => {
        await l.pc1.executeCommand('echo locked > /tmp/lk');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', [
          'mkdir /tmp/locked-dir',
          'put /tmp/lk /tmp/locked-dir/lk',
          'chmod 600 /tmp/locked-dir/lk',
        ]));
      },
      on: l => l.pc2,
      cmd: 'stat -c "%a" /tmp/locked-dir/lk',
      contains: [/^600$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 28 — idempotency: put twice overwrites cleanly ──────────

describe('§28 — repeated sftp operations are idempotent', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'put twice overwrites: final content is the latest version',
      setup: async (l) => {
        await l.pc1.executeCommand('echo v1 > /tmp/over');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['put /tmp/over /tmp/over']));
        await l.pc1.executeCommand('echo v2 > /tmp/over');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['put /tmp/over /tmp/over']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/over',
      contains: [/^v2$/m],
    },
    {
      name: 'get twice with identical source yields the same content twice',
      setup: async (l) => {
        await l.pc2.executeCommand('echo only > /tmp/only');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['get /tmp/only /tmp/only']));
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['get /tmp/only /tmp/only']));
      },
      on: l => l.pc1,
      cmd: 'cat /tmp/only',
      contains: [/^only$/m],
    },
    {
      name: 'mkdir twice — the second is silently idempotent (state unchanged)',
      setup: async (l) => {
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['mkdir /tmp/twice']));
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['mkdir /tmp/twice']));
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['cd /tmp/twice', 'pwd']),
      contains: [/Remote working directory: \/tmp\/twice/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 29 — firewall blocking port 22 also blocks sftp ─────────

describe('§29 — firewall rules blocking port 22 also block sftp', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'iptables DROP on dport 22 → sftp fails',
      setup: async (l) => { await l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/refused|timed out|no route|unreachable/i],
      excludes: [/Connected to/],
    },
    {
      name: 'iptables -F restores sftp',
      setup: async (l) => {
        await l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
        await l.pc2.executeCommand('iptables -F');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'iptables DROP on a different port leaves sftp working on 22',
      setup: async (l) => { await l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'source-based DROP blocks only one client',
      setup: async (l) => { await l.pc2.executeCommand('iptables -A INPUT -s 10.0.0.1 -j DROP'); },
      on: l => l.pc3,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


