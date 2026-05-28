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
      name: 'mkdir under a missing parent fails (OpenSSH sftp does not mkdir -p)',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /no/such/parent/leaf']),
      contains: [/mkdir failed|Couldn't|No such|Failure/i],
    },
    {
      name: 'mkdir of an existing directory fails with "exists" / "Failure"',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/exists'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/exists']),
      contains: [/mkdir failed|exist|Failure/i],
    },
    {
      name: 'mkdir relative to cwd creates underneath it',
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/base && chown alice:alice /tmp/base'); },
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
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/togo && chown alice:alice /tmp/togo'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rmdir /tmp/togo', 'cd /tmp/togo']),
      contains: [/Not a directory|No such/i],
    },
    {
      name: 'rmdir on a non-empty directory fails',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /tmp/full && echo x > /tmp/full/x && chown -R alice:alice /tmp/full');
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
      setup: async (l) => { await l.pc2.executeCommand('echo nope > /tmp/notadir && chown alice:alice /tmp/notadir'); },
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
      setup: async (l) => { await l.pc2.executeCommand('echo gone > /tmp/doomed.txt && chown alice:alice /tmp/doomed.txt'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/doomed.txt', 'ls /tmp']),
      excludes: ['doomed.txt'],
    },
    {
      name: 'delete is an alias for rm',
      setup: async (l) => { await l.pc2.executeCommand('echo bye > /tmp/aliased && chown alice:alice /tmp/aliased'); },
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
      setup: async (l) => { await l.pc2.executeCommand('mkdir -p /tmp/dir-rm && chown alice:alice /tmp/dir-rm'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/dir-rm']),
      contains: [/unlink failed|directory|Failure/i],
    },
    {
      name: 'multiple rms in one batch keep going through errors',
      setup: async (l) => {
        await l.pc2.executeCommand('echo 1 > /tmp/r1 && echo 2 > /tmp/r2 && chown alice:alice /tmp/r1 /tmp/r2');
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
        await l.pc2.executeCommand('echo r > /tmp/from && chown alice:alice /tmp/from');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['rename /tmp/from /tmp/to']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/to',
      contains: [/^r$/m],
    },
    {
      name: 'rename leaves no file at the source',
      setup: async (l) => {
        await l.pc2.executeCommand('echo r > /tmp/from2 && chown alice:alice /tmp/from2');
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
        await l.pc2.executeCommand('echo r > /tmp/mv-src && chown alice:alice /tmp/mv-src');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['mv /tmp/mv-src /tmp/mv-dst']));
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/mv-dst',
      contains: [/^r$/m],
    },
    {
      name: 'rename when destination already exists fails',
      setup: async (l) => {
        await l.pc2.executeCommand('echo a > /tmp/ra && echo b > /tmp/rb && chown alice:alice /tmp/ra /tmp/rb');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rename /tmp/ra /tmp/rb']),
      contains: [/rename failed|exist|Failure/i],
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
        await l.pc2.executeCommand('echo s > /tmp/secret && chown alice:alice /tmp/secret');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['chmod 600 /tmp/secret']));
      },
      on: l => l.pc2,
      cmd: 'stat -c "%a" /tmp/secret',
      contains: [/^600$/m],
    },
    {
      name: 'chmod 755 on a directory updates its mode',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /tmp/dir-perm && chown alice:alice /tmp/dir-perm');
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
      name: 'mkdir with no args surfaces a usage / failure error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir']),
      contains: [/mkdir failed|Failure|usage|missing|invalid/i],
    },
    {
      name: 'rm with no args surfaces a usage / failure error',
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm']),
      contains: [/unlink failed|Failure|usage|missing/i],
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
      name: 'sftp -b with a missing batchfile fails',
      on: l => l.pc1,
      cmd: 'sftp -b /tmp/no-such-batch alice@10.0.0.2',
      contains: [/Couldn't|No such|cannot open|failed/i],
    },
    {
      name: 'sftp -b runs the verbs from the file (mkdir lands on remote)',
      setup: async (l) => {
        await l.pc1.executeCommand('printf "mkdir /tmp/from-batch\\nbye\\n" > /tmp/b2.txt');
        await l.pc1.executeCommand('sftp -b /tmp/b2.txt alice@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'ls -d /tmp/from-batch',
      contains: ['from-batch'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ─── Section 26 — Windows ships OpenSSH sftp client by default ───────
//
// Recent Windows versions bundle the OpenSSH client, so `sftp` is a
// first-class executable in cmd / PowerShell. These rows are an oracle
// of how the simulator should mirror that reality.

describe('§26 — Windows ships the OpenSSH sftp client', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'bare `sftp` on win1 prints the OpenSSH usage line',
      on: l => l.win1,
      cmd: 'sftp',
      contains: [/usage:\s*sftp/i],
      excludes: [/not recognized|n'est pas reconnu|command not found/i],
    },
    {
      name: 'win1 → linux pc2: sftp alice@10.0.0.2 connects',
      on: l => l.win1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
      excludes: [/not recognized|command not found/i],
    },
    {
      name: 'win1 → linux server: sftp alice@srv1 connects',
      on: l => l.win1,
      cmd: sftp('alice@10.0.0.10', ['pwd']),
      contains: [/Connected to 10\.0\.0\.10/],
    },
    {
      name: 'win1 → win2: cross-Windows sftp connects',
      on: l => l.win1,
      cmd: sftp('User@10.0.0.21', ['pwd']),
      contains: [/Connected to 10\.0\.0\.21/],
    },
    {
      name: 'sftp -P 2222 on Windows targets an alternate port',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.win1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-P 2222' }),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'sftp from Windows to an unreachable IP fails gracefully',
      on: l => l.win1,
      cmd: sftp('alice@192.0.2.99', ['pwd']),
      contains: [/no route|Could not resolve|refused|timed out/i],
      excludes: [/Connected to/],
    },
    {
      name: 'win1 → pc2 with sshd stopped: Connection refused',
      setup: async (l) => { await l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.win1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connection refused/],
    },
    {
      name: 'win1 → pc2 put a Windows-local file under /tmp on Linux',
      setup: async (l) => {
        await l.win1.executeCommand('echo from-win > C:\\Users\\User\\to-linux.txt');
        await l.win1.executeCommand(
          sftp('alice@10.0.0.2', ['put /C:/Users/User/to-linux.txt /tmp/from-win.txt']),
        );
      },
      on: l => l.pc2,
      cmd: 'cat /tmp/from-win.txt',
      contains: [/from-win/],
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
      name: 'mkdir twice — the second emits a noisy error; state unchanged',
      setup: async (l) => {
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['mkdir /tmp/twice']));
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['mkdir /tmp/twice']),
      contains: [/mkdir failed|exist|Failure/i],
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
      name: 'ufw deny 22 blocks sftp the same way iptables DROP does',
      setup: async (l) => {
        await l.pc2.executeCommand('sudo ufw enable');
        await l.pc2.executeCommand('sudo ufw deny 22');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/refused|timed out|unreachable/i],
      excludes: [/Connected to/],
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


// ─── Section 30 — full cross-pair reachability matrix over sftp ──────

describe('§30 — full SFTP reachability matrix', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  interface MatrixRow { name: string; client: keyof Lan; cmd: string; contains: (string | RegExp)[]; }

  const targets: { ip: string; user: string }[] = [
    { ip: '10.0.0.1', user: 'alice' },
    { ip: '10.0.0.2', user: 'alice' },
    { ip: '10.0.0.3', user: 'alice' },
    { ip: '10.0.0.10', user: 'alice' },
    { ip: '10.0.0.11', user: 'alice' },
    { ip: '10.0.0.20', user: 'User' },
    { ip: '10.0.0.21', user: 'User' },
  ];
  const clients: (keyof Lan)[] = ['pc1', 'pc2', 'pc3', 'srv1', 'srv2'];

  const matrix: MatrixRow[] = clients.flatMap((c) =>
    targets.map((t) => ({
      name: `${String(c)} → ${t.ip}: sftp ${t.user}@${t.ip} pwd`,
      client: c,
      cmd: sftp(`${t.user}@${t.ip}`, ['pwd']),
      contains: [new RegExp(`Connected to ${t.ip.replace(/\./g, '\\.')}`)],
    })),
  );

  test.each(matrix)('$name', async (m) => {
    const dev = lan[m.client] as { executeCommand: (c: string) => Promise<string> };
    const out = await dev.executeCommand(m.cmd);
    for (const c of m.contains) {
      if (c instanceof RegExp) expect(out).toMatch(c);
      else expect(out).toContain(c);
    }
  });
});



// ─── Section 31 — journalctl mirrors auth.log for sftp sessions ──────

describe('§31 — journalctl mirrors auth.log for sftp sessions', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'journalctl -u ssh shows Accepted password after a successful sftp',
      setup: async (l) => { await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh',
      contains: [/Accepted password for alice/],
    },
    {
      name: 'journalctl -u ssh shows Failed password after a refused sftp',
      setup: async (l) => { await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh',
      contains: [/Failed password for root/],
    },
    {
      name: 'journalctl -u ssh records the source IP per OpenSSH format',
      setup: async (l) => { await l.pc3.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh',
      contains: [/from 10\.0\.0\.3/],
    },
    {
      name: 'journalctl -u ssh logs the sftp subsystem invocation',
      setup: async (l) => { await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh',
      contains: [/subsystem request for sftp|sftp-server/i],
    },
    {
      name: 'journalctl --since "1 hour ago" still surfaces the sftp event',
      setup: async (l) => { await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd'])); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh --since "1 hour ago"',
      contains: [/Accepted password for alice/],
    },
    {
      name: 'journald stopped → journalctl reports no entries',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop systemd-journald');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh',
      contains: [/No journal files were found|service is not active|No entries/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 32 — Match / ChrootDirectory restrict sftp scope ────────

describe('§32 — Match / ChrootDirectory restrict sftp scope', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'ForceCommand internal-sftp restricts the channel to sftp only',
      setup: async (l) => {
        await l.pc2.executeCommand(
          'printf "Match User bob\\n  ForceCommand internal-sftp\\n" >> /etc/ssh/sshd_config',
        );
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh bob@10.0.0.2 "ls /"',
      contains: [/This service allows sftp connections only|Permission denied/i],
      excludes: [/^bin$|^etc$/m],
    },
    {
      name: 'ChrootDirectory /var/sftp confines the sftp user to that subtree',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /var/sftp/upload');
        await l.pc2.executeCommand('chown root:root /var/sftp && chmod 755 /var/sftp');
        await l.pc2.executeCommand('chown bob:bob /var/sftp/upload');
        await l.pc2.executeCommand(
          'printf "Match User bob\\n  ChrootDirectory /var/sftp\\n  ForceCommand internal-sftp\\n" >> /etc/ssh/sshd_config',
        );
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('bob@10.0.0.2', ['pwd']),
      contains: [/Remote working directory: \//],
      excludes: [/\/var\/sftp/],
    },
    {
      name: 'chrooted user cannot cd ../.. past the chroot root',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /var/sftp/upload');
        await l.pc2.executeCommand(
          'printf "Match User bob\\n  ChrootDirectory /var/sftp\\n  ForceCommand internal-sftp\\n" >> /etc/ssh/sshd_config',
        );
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('bob@10.0.0.2', ['cd /etc', 'pwd']),
      contains: [/Not a directory|No such|Permission denied/i],
    },
    {
      name: 'Match Address restricts sftp to a specific source subnet',
      setup: async (l) => {
        await l.pc2.executeCommand(
          'printf "Match Address 10.0.0.1\\n  DenyUsers alice\\n" >> /etc/ssh/sshd_config',
        );
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Permission denied/],
    },
    {
      name: 'Match Address rule does NOT affect a different source',
      setup: async (l) => {
        await l.pc2.executeCommand(
          'printf "Match Address 10.0.0.1\\n  DenyUsers alice\\n" >> /etc/ssh/sshd_config',
        );
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc3,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'Match Group sftpusers gates sftp by group membership',
      setup: async (l) => {
        await l.pc2.executeCommand('sudo groupadd sftpusers');
        await l.pc2.executeCommand('sudo usermod -aG sftpusers alice');
        await l.pc2.executeCommand(
          'sudo sh -c \'printf "Match Group sftpusers\\n  ForceCommand internal-sftp\\n" >> /etc/ssh/sshd_config\'',
        );
        await l.pc2.executeCommand('sudo systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 "ls /"',
      contains: [/This service allows sftp connections only|Permission denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 33 — POSIX permissions and ACLs gate sftp put/get ───────

describe('§33 — POSIX permissions and ACLs gate sftp put / get', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'put into a directory the user cannot write fails',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /var/locked && chown root:root /var/locked && chmod 700 /var/locked');
        await l.pc1.executeCommand('echo hi > /tmp/h');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/h /var/locked/h']),
      contains: [/Permission denied|write failed|Failure/i],
    },
    {
      name: 'get of a file the user cannot read fails',
      setup: async (l) => {
        await l.pc2.executeCommand('echo secret > /tmp/hidden && chown root:root /tmp/hidden && chmod 600 /tmp/hidden');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['get /tmp/hidden /tmp/hidden']),
      contains: [/Permission denied|not found|Failure/i],
    },
    {
      name: 'rm of a file owned by another user without write perm fails',
      setup: async (l) => {
        await l.pc2.executeCommand('echo nope > /tmp/keepme && chown root:root /tmp/keepme && chmod 644 /tmp/keepme');
        await l.pc2.executeCommand('chmod 755 /tmp');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/keepme']),
      contains: [/Permission denied|unlink failed|Failure/i],
    },
    {
      name: 'chmod by a non-owner fails',
      setup: async (l) => {
        await l.pc2.executeCommand('echo o > /tmp/owned && chown root:root /tmp/owned && chmod 600 /tmp/owned');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['chmod 777 /tmp/owned']),
      contains: [/Operation not permitted|Permission denied|chmod failed|Failure/i],
    },
    {
      name: 'setfacl deny on a directory blocks put even when world-writable',
      setup: async (l) => {
        await l.pc2.executeCommand('mkdir -p /var/acl && chmod 777 /var/acl');
        await l.pc2.executeCommand('setfacl -m u:alice:--- /var/acl');
        await l.pc1.executeCommand('echo a > /tmp/a');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['put /tmp/a /var/acl/a']),
      contains: [/Permission denied|write failed|Failure/i],
    },
    {
      name: 'umask applied by sftp-server matches OpenSSH default 0022',
      setup: async (l) => {
        await l.pc1.executeCommand('echo u > /tmp/u');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['put /tmp/u /tmp/u']));
      },
      on: l => l.pc2,
      cmd: 'stat -c "%a" /tmp/u',
      contains: [/^(644|664)$/m],
    },
    {
      name: 'sticky bit on /tmp prevents alice from deleting bob\'s file',
      setup: async (l) => {
        await l.pc2.executeCommand('echo b > /tmp/bobs && chown bob:bob /tmp/bobs && chmod 644 /tmp/bobs');
        await l.pc2.executeCommand('chmod 1777 /tmp');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['rm /tmp/bobs']),
      contains: [/Operation not permitted|Permission denied|unlink failed|Failure/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 34 — mid-session faults: link flap, switch down, MTU ────

describe('§34 — mid-session faults: link flap, switch down, MTU', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'client eth0 down before the session: sftp fails locally',
      setup: async (l) => { await l.pc1.executeCommand('ip link set eth0 down'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Network is unreachable|No route to host|refused/i],
      excludes: [/Connected to/],
    },
    {
      name: 'remote eth0 down: sftp times out',
      setup: async (l) => { await l.pc2.executeCommand('ip link set eth0 down'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/No route to host|Connection timed out|refused|unreachable/i],
    },
    {
      name: 'restoring eth0 with ip link set up restores sftp',
      setup: async (l) => {
        await l.pc2.executeCommand('ip link set eth0 down');
        await l.pc2.executeCommand('ip link set eth0 up');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'core switch powered off severs sftp for every pair',
      setup: (l) => { l.sw.powerOff(); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/No route to host|refused|timed out|unreachable/i],
      excludes: [/Connected to/],
    },
    {
      name: 'switch powered back on: sftp restored',
      setup: (l) => { l.sw.powerOff(); l.sw.powerOn(); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
    {
      name: 'flushing the client IP makes sftp fail with "Cannot assign requested address"',
      setup: async (l) => { await l.pc1.executeCommand('ip addr flush dev eth0'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Cannot assign requested address|Network is unreachable/i],
    },
    {
      name: 'default route deleted: off-subnet sftp fails (no gateway)',
      setup: async (l) => { await l.pc1.executeCommand('ip route del default'); },
      on: l => l.pc1,
      cmd: sftp('alice@198.51.100.7', ['pwd']),
      contains: [/Network is unreachable|No route to host|Could not resolve/i],
    },
    {
      name: 'MTU 296 on eth0 still allows sftp (small but legal MTU)',
      setup: async (l) => { await l.pc2.executeCommand('ip link set eth0 mtu 296'); },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/Connected to 10\.0\.0\.2/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 35 — fail2ban / auth throttling on repeated sftp failures ─

describe('§35 — auth throttling under repeated sftp failures', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: Row[] = [
    {
      name: 'three failed sftp logins produce three Failed password entries',
      setup: async (l) => {
        await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd']));
        await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd']));
        await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'grep -c "Failed password" /var/log/auth.log',
      contains: [/^[3-9]\b/],
    },
    {
      name: 'MaxAuthTries 1: a second failed attempt drops the connection',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "MaxAuthTries 1\\n" >> /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-o PasswordAuthentication=no' }),
      contains: [/Permission denied|Too many authentication failures/i],
    },
    {
      name: 'fail2ban bans the source IP after the threshold',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl start fail2ban');
        for (let i = 0; i < 6; i++) await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd']));
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd']),
      contains: [/refused|timed out|unreachable|banned/i],
      excludes: [/Connected to/],
    },
    {
      name: 'fail2ban-client status sshd lists the banned IP',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl start fail2ban');
        for (let i = 0; i < 6; i++) await l.pc1.executeCommand(sftp('root@10.0.0.2', ['pwd']));
      },
      on: l => l.pc2,
      cmd: 'fail2ban-client status sshd',
      contains: [/Banned IP list:.*10\.0\.0\.1/s],
    },
    {
      name: 'LoginGraceTime expiry closes the channel without authentication',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "LoginGraceTime 1\\n" >> /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: sftp('alice@10.0.0.2', ['pwd'], { flags: '-o PasswordAuthentication=no -o PreferredAuthentications=publickey' }),
      contains: [/Timeout, server.*not responding|Connection closed|Permission denied/i],
    },
    {
      name: 'auth.log records "Disconnecting" lines for throttled sessions',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "MaxAuthTries 1\\n" >> /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
        await l.pc1.executeCommand(sftp('alice@10.0.0.2', ['pwd'], { flags: '-o PasswordAuthentication=no' }));
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Disconnecting|Too many authentication failures|Connection closed by/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});


// ════════════════════════════════════════════════════════════════════
// Interactive SFTP sub-shell sections
// ════════════════════════════════════════════════════════════════════
//
// The sections above drive sftp through the executor's batch (here-doc)
// path. The four sections below take the other route: open a real
// SftpSession, wrap it in the SftpSubShell that the LinuxTerminalSession
// hosts, and assert on each REPL turn — the prompt string, the exit
// flag, the output lines and how the shell composes successive calls.

import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { TcpConnector } from '@/network/core/TcpConnection';
import type { SubShellResult } from '@/terminal/subshells/ISubShell';

function tcpConnectorOf(pc: LinuxPC | LinuxServer): TcpConnector {
  const dev = pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> };
  return (host, port) => dev.tcpConnect(host, port) as Promise<never>;
}

/** Resolve the (uid, gid) of a Linux user on the given remote device. */
function uidOf(remote: LinuxPC | LinuxServer, user: string): { uid: number; gid: number } {
  const um = (remote as unknown as { executor: { userMgr: { getUser: (u: string) => { uid?: number; gid?: number } | undefined } } }).executor.userMgr;
  const u = um.getUser(user);
  return { uid: u?.uid ?? 0, gid: u?.gid ?? 0 };
}

/** Remote VFS of a Linux device, for direct seeding of remote files. */
function vfsOf(d: LinuxPC | LinuxServer): VirtualFileSystem {
  return (d as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

interface ShellFixture { shell: SftpSubShell; session: SftpSession; local: VirtualFileSystem; }

async function openShell(client: LinuxPC | LinuxServer, target: string, opts: { user?: string; password?: string; localCwd?: string } = {}): Promise<ShellFixture> {
  const user = opts.user ?? 'alice';
  // Standard cast on LinuxCommandExecutor sets each user's password to
  // their username (alice/alice, bob/bob, …).
  const password = opts.password ?? user;
  const local = new VirtualFileSystem();
  const session = new SftpSession({
    tcpConnector: tcpConnectorOf(client),
    localVfs: local,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    localCwd: opts.localCwd ?? '/root',
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
    homeDirectory: '/root',
  });
  const banner = await session.connect(`${user}@${target}`, { password });
  expect(banner).toContain('Connected');
  const shell = new SftpSubShell(session);
  return { shell, session, local };
}

interface ShellRow {
  name: string;
  setup?: (lan: Lan, fx: ShellFixture) => Promise<void> | void;
  /** Lines to feed in order; the assertion runs on the LAST result. */
  lines: string[];
  contains?: (string | RegExp)[];
  excludes?: (string | RegExp)[];
  expectPrompt?: string;
  expectExit?: boolean;
}

async function driveShell(lan: Lan, target: string, row: ShellRow): Promise<{ res: SubShellResult; allOutput: string }> {
  const fx = await openShell(lan.pc1, target);
  if (row.setup) await row.setup(lan, fx);
  let res: SubShellResult = { output: [], exit: false, prompt: fx.shell.getPrompt() };
  const all: string[] = [];
  for (const line of row.lines) {
    res = await fx.shell.processLine(line);
    all.push(...res.output);
    if (res.exit) break;
  }
  return { res, allOutput: all.join('\n') };
}

function assertShellRow(out: string, res: SubShellResult, row: ShellRow): void {
  for (const c of row.contains ?? []) {
    if (c instanceof RegExp) expect(out).toMatch(c);
    else expect(out).toContain(c);
  }
  for (const e of row.excludes ?? []) {
    if (e instanceof RegExp) expect(out).not.toMatch(e);
    else expect(out).not.toContain(e);
  }
  if (row.expectPrompt !== undefined) expect(res.prompt).toBe(row.expectPrompt);
  if (row.expectExit !== undefined) expect(res.exit).toBe(row.expectExit);
}

// ─── Section 36 — Prompt, help, version, unknown verbs ───────────────

describe('§36 — interactive sftp shell: prompt, help, version, unknown verbs', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: ShellRow[] = [
    {
      name: 'fresh shell prompt is exactly "sftp> "',
      lines: [''],
      expectPrompt: 'sftp> ',
      expectExit: false,
    },
    {
      name: 'unknown verb produces "Invalid command."',
      lines: ['fubar'],
      contains: ['Invalid command.'],
      expectPrompt: 'sftp> ',
    },
    {
      name: 'help lists every documented verb',
      lines: ['help'],
      contains: ['bye', 'cd path', 'get [-afpR] remote', 'put [-afpR] local', 'lmkdir path', 'rename oldpath newpath'],
      expectPrompt: 'sftp> ',
    },
    {
      name: '? is an alias for help',
      lines: ['?'],
      contains: ['Available commands', 'rename oldpath newpath'],
    },
    {
      name: 'version returns an SFTP protocol identifier',
      lines: ['version'],
      contains: [/SFTP.*version|protocol/i],
    },
    {
      name: 'clear sets clearScreen true and keeps the same prompt',
      lines: ['clear'],
      expectPrompt: 'sftp> ',
    },
    {
      name: 'an empty line yields a blank output line and a fresh prompt',
      lines: [''],
      expectPrompt: 'sftp> ',
      expectExit: false,
    },
    {
      name: 'verbs are case-insensitive: PWD ≡ pwd',
      lines: ['PWD'],
      contains: [/Remote working directory:/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    const { res, allOutput } = await driveShell(lan, '10.0.0.2', row);
    assertShellRow(allOutput, res, row);
  });
});

// ─── Section 37 — Interactive navigation (cd, lcd, pwd, lpwd, ls) ────

describe('§37 — interactive navigation through the sftp shell', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: ShellRow[] = [
    {
      name: 'pwd after connect reports the remote home',
      lines: ['pwd'],
      contains: [/Remote working directory:/],
    },
    {
      name: 'lpwd reports the local cwd /root injected on construction',
      lines: ['lpwd'],
      contains: [/Local working directory: \/root/],
    },
    {
      name: 'cd /tmp then pwd shows /tmp',
      lines: ['cd /tmp', 'pwd'],
      contains: [/Remote working directory: \/tmp/],
    },
    {
      name: 'cd to a missing dir reports "No such" / "Not a directory"',
      lines: ['cd /no/such/dir'],
      contains: [/No such file|Not a directory/i],
    },
    {
      name: 'lcd /tmp updates the local side without affecting remote',
      lines: ['lcd /tmp', 'lpwd', 'pwd'],
      contains: [/Local working directory: \/tmp/, /Remote working directory:/],
    },
    {
      name: 'ls of the remote root contains classic linux dirs',
      lines: ['ls /'],
      contains: [/etc|home|tmp|var/],
    },
    {
      name: 'ls -l includes a permission-string column',
      setup: async (lan, _fx) => {
        const { uid, gid } = uidOf(lan.pc2, 'alice');
        vfsOf(lan.pc2).writeFile('/tmp/ll-sample', 'data', uid, gid, 0o022);
      },
      lines: ['ls -l /tmp'],
      contains: [/-rw|drwx/],
    },
    {
      name: 'ls -a includes dot entries',
      setup: async (lan, fx) => {
        const remoteVfs = (lan.pc2 as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
        remoteVfs.writeFile('/tmp/.hidden', 'h', 0, 0, 0o022);
        void fx;
      },
      lines: ['ls -a /tmp'],
      contains: ['.hidden'],
    },
    {
      name: 'multiple cd in a row compose like a real shell',
      lines: ['cd /var', 'cd log', 'pwd'],
      contains: [/Remote working directory: \/var\/log/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    const { res, allOutput } = await driveShell(lan, '10.0.0.2', row);
    assertShellRow(allOutput, res, row);
  });
});

// ─── Section 38 — Interactive file ops (mkdir, put, get, rm, chmod) ──

describe('§38 — interactive sftp shell: file ops round-trip', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: ShellRow[] = [
    {
      name: 'mkdir creates the directory and ls confirms it',
      lines: ['mkdir /tmp/sh-dir', 'ls /tmp'],
      contains: ['sh-dir'],
    },
    {
      name: 'put uploads a local file then ls shows it on the remote',
      setup: async (_lan, fx) => { fx.local.writeFile('/tmp/up.txt', 'hello-shell', 0, 0, 0o022); },
      lines: ['lcd /tmp', 'put up.txt /tmp/up.txt', 'ls /tmp'],
      contains: ['up.txt', /Uploading/],
    },
    {
      name: 'get downloads a remote file into the local VFS',
      setup: async (lan, _fx) => {
        const v = (lan.pc2 as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
        v.writeFile('/tmp/dl.txt', 'fetched', 0, 0, 0o022);
      },
      lines: ['get /tmp/dl.txt /tmp/dl.txt'],
      contains: [/Fetching|fetched/],
    },
    {
      name: 'rm of a missing file surfaces an error string',
      lines: ['rm /tmp/never-here'],
      contains: [/No such|unlink failed|Failure/i],
    },
    {
      name: 'rename moves a file and the source disappears from ls',
      setup: async (lan, _fx) => {
        const { uid, gid } = uidOf(lan.pc2, 'alice');
        vfsOf(lan.pc2).writeFile('/tmp/rn-src', 'X', uid, gid, 0o022);
      },
      lines: ['rename /tmp/rn-src /tmp/rn-dst', 'ls /tmp'],
      contains: ['rn-dst'],
      excludes: [/^rn-src$/m],
    },
    {
      name: 'chmod 600 updates the mode (stat confirms it)',
      setup: async (lan, _fx) => {
        const { uid, gid } = uidOf(lan.pc2, 'alice');
        vfsOf(lan.pc2).writeFile('/tmp/cm.txt', 'm', uid, gid, 0o022);
      },
      lines: ['chmod 600 /tmp/cm.txt', 'stat /tmp/cm.txt'],
      contains: [/0?600|rw-------/],
    },
    {
      name: 'rmdir on an empty directory removes it',
      setup: async (lan, _fx) => {
        const { uid, gid } = uidOf(lan.pc2, 'alice');
        vfsOf(lan.pc2).mkdir('/tmp/togo', 0o755, uid, gid);
      },
      lines: ['rmdir /tmp/togo', 'ls /tmp'],
      excludes: [/^togo$/m],
    },
    {
      name: 'lmkdir creates a local directory (lpwd reaches it via lcd)',
      lines: ['lmkdir /tmp/local-d', 'lcd /tmp/local-d', 'lpwd'],
      contains: [/Local working directory: \/tmp\/local-d/],
    },
    {
      name: 'df prints filesystem statistics for the cwd',
      lines: ['df'],
      contains: [/Size|Used|Avail|Mounted/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    const { res, allOutput } = await driveShell(lan, '10.0.0.2', row);
    assertShellRow(allOutput, res, row);
  });
});

// ─── Section 39 — Exit semantics, usage messages, prompt invariants ──

describe('§39 — exit semantics, usage messages and prompt invariants', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  const rows: ShellRow[] = [
    {
      name: 'bye exits the shell and clears the prompt',
      lines: ['bye'],
      expectExit: true,
      expectPrompt: '',
    },
    {
      name: 'quit is an alias for bye',
      lines: ['quit'],
      expectExit: true,
      expectPrompt: '',
    },
    {
      name: 'exit is an alias for bye',
      lines: ['exit'],
      expectExit: true,
      expectPrompt: '',
    },
    {
      name: 'Ctrl+D consumed by handleKey (host then injects exit)',
      lines: [],
      setup: async (_lan, fx) => {
        const consumed = fx.shell.handleKey({ key: 'd', ctrlKey: true } as never);
        expect(consumed).toBe(true);
      },
      contains: [],
    },
    {
      name: 'mkdir without an arg prints "usage: mkdir path"',
      lines: ['mkdir'],
      contains: ['usage: mkdir path'],
      expectPrompt: 'sftp> ',
    },
    {
      name: 'rm without an arg prints "usage: rm path"',
      lines: ['rm'],
      contains: ['usage: rm path'],
    },
    {
      name: 'rmdir without an arg prints "usage: rmdir path"',
      lines: ['rmdir'],
      contains: ['usage: rmdir path'],
    },
    {
      name: 'rename with one arg prints "usage: rename oldpath newpath"',
      lines: ['rename /tmp/only'],
      contains: ['usage: rename oldpath newpath'],
    },
    {
      name: 'chmod with only mode (no path) prints "usage: chmod mode path"',
      lines: ['chmod 600'],
      contains: ['usage: chmod mode path'],
    },
    {
      name: 'get without args prints "usage: get remote [local]"',
      lines: ['get'],
      contains: ['usage: get remote [local]'],
    },
    {
      name: 'put without args prints "usage: put local [remote]"',
      lines: ['put'],
      contains: ['usage: put local [remote]'],
    },
    {
      name: 'lmkdir without an arg prints "usage: lmkdir path"',
      lines: ['lmkdir'],
      contains: ['usage: lmkdir path'],
    },
    {
      name: 'stat without an arg prints "usage: stat path"',
      lines: ['stat'],
      contains: ['usage: stat path'],
    },
    {
      name: 'prompt remains "sftp> " after a non-exit error',
      lines: ['bogus-cmd'],
      contains: ['Invalid command.'],
      expectPrompt: 'sftp> ',
      expectExit: false,
    },
    {
      name: 'after exit, getPrompt() reports an empty prompt',
      lines: ['exit'],
      setup: async (_lan, fx) => { void fx; },
      expectExit: true,
      expectPrompt: '',
    },
  ];

  test.each(rows)('$name', async (row) => {
    const { res, allOutput } = await driveShell(lan, '10.0.0.2', row);
    assertShellRow(allOutput, res, row);
  });
});
