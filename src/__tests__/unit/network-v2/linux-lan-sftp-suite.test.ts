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

