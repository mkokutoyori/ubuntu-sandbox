/**
 * Linux LAN SSH suite — end-to-end exploratory tests.
 *
 * These tests are deliberately written as an oracle of how a *real*
 * Linux LAN should behave under realistic SSH usage. They are not
 * shaped to the current implementation: any failure pinpoints a
 * feature gap or a regression to fix.
 *
 * Topology (built fresh per test):
 *
 *     pc1 ─┐                            ┌─ srv1 (oracle)
 *     pc2 ─┼─ hub ─┬─────────────────── ┤
 *     pc3 ─┤       │                    └─ srv2 (file/web server)
 *          │       │
 *     pc4 ─┘       (10.0.0.0/24)
 *
 * Conventions:
 *   - pc1=10.0.0.1 pc2=10.0.0.2 pc3=10.0.0.3 pc4=10.0.0.4
 *     srv1=10.0.0.10 srv2=10.0.0.11
 *   - Tests use the `alice` non-root user where SSH login is needed,
 *     so PermitRootLogin no (the OpenSSH default we ship with) doesn't
 *     interfere unless the test is specifically exercising root login.
 *   - Each section is its own describe block. test.each drives every
 *     section so adding cases is one row of data.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── LAN fixture ────────────────────────────────────────────────────

export interface Lan {
  pc1: LinuxPC; pc2: LinuxPC; pc3: LinuxPC; pc4: LinuxPC;
  srv1: LinuxServer; srv2: LinuxServer;
  hub: Hub;
  ipOf: Record<string, string>;
}

function buildLan(): Lan {
  EquipmentRegistry.getInstance().clear();
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc2', 0, 0);
  const pc3 = new LinuxPC('linux-pc', 'pc3', 0, 0);
  const pc4 = new LinuxPC('linux-pc', 'pc4', 0, 0);
  const srv1 = new LinuxServer('linux-server', 'srv1', 0, 0);
  const srv2 = new LinuxServer('linux-server', 'srv2', 0, 0);
  const hub = new Hub('hub', 'core', 0, 0);
  const all: (LinuxPC | LinuxServer)[] = [pc1, pc2, pc3, pc4, srv1, srv2];
  all.forEach((d, i) => { new Cable(d.getPorts()[0], hub.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc3.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc4.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  srv1.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  srv2.getPorts()[0].configureIP(new IPAddress('10.0.0.11'), mask);

  return {
    pc1, pc2, pc3, pc4, srv1, srv2, hub,
    ipOf: {
      pc1: '10.0.0.1', pc2: '10.0.0.2', pc3: '10.0.0.3', pc4: '10.0.0.4',
      srv1: '10.0.0.10', srv2: '10.0.0.11',
    },
  };
}

// ─── Row helpers used by every section ──────────────────────────────

type Dev = LinuxPC | LinuxServer;

interface Row {
  /** Human-readable test label (test.each $name). */
  name: string;
  /** Optional setup steps run on the LAN before the assertion. */
  setup?: (lan: Lan) => Promise<void> | void;
  /** Device executing the command under test. */
  on: (lan: Lan) => Dev;
  /** The command line. */
  cmd: string;
  /** Substrings the output must contain (all of them). */
  contains?: (string | RegExp)[];
  /** Substrings the output must NOT contain (none of them). */
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

// ─── Section 1 — SSH happy path (PC↔PC, PC↔Server, Server↔Server) ────

describe('§1 — SSH happy path across the LAN', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'PC→PC: ssh alice@pc2 connects and greets',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu', /Connection to 10\.0\.0\.2 closed/],
      excludes: [/Connection refused/, /Permission denied/, /Could not resolve/],
    },
    {
      name: 'PC→Server: ssh alice@srv1 reaches the database server',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10',
      contains: ['Welcome to Ubuntu', /Connection to 10\.0\.0\.10 closed/],
      excludes: [/refused/, /denied/],
    },
    {
      name: 'Server→PC: srv1 administrator reaches a workstation',
      on: l => l.srv1,
      cmd: 'ssh alice@10.0.0.3',
      contains: ['Welcome to Ubuntu'],
      excludes: [/refused/],
    },
    {
      name: 'Server→Server: srv1 reaches srv2 for cluster admin',
      on: l => l.srv1,
      cmd: 'ssh alice@10.0.0.11',
      contains: ['Welcome to Ubuntu'],
      excludes: [/refused/],
    },
    {
      name: 'PC→PC: a multi-hop friendly LAN (pc4→pc1) works',
      on: l => l.pc4,
      cmd: 'ssh alice@10.0.0.1',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'When the user is omitted, current user is used',
      on: l => l.pc1,
      cmd: 'ssh 10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Permission denied/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 2 — SSH banner, MOTD, /etc/issue.net ────────────────────

describe('§2 — SSH banner, MOTD and issue.net', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'remote /etc/motd is displayed in the welcome',
      setup: (l) => { void l.pc2.executeCommand("echo 'Property of ACME Corp' > /etc/motd"); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Property of ACME Corp'],
    },
    {
      name: '/etc/issue.net is shown pre-auth',
      setup: (l) => { void l.pc2.executeCommand("echo 'AUTHORIZED USE ONLY' > /etc/issue.net"); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['AUTHORIZED USE ONLY'],
    },
    {
      name: 'Ubuntu LSB release line appears in the banner',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Ubuntu 22\.04|Ubuntu 20\.04|Ubuntu \d+\.\d+/],
    },
    {
      name: 'kernel release line is included',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/GNU\/Linux 5\.\d+\.\d+/],
    },
    {
      name: 'last login marker is appended',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Last login:/],
    },
    {
      name: 'banner suppression with -q is honoured',
      on: l => l.pc1,
      cmd: 'ssh -q alice@10.0.0.2',
      excludes: ['Welcome to Ubuntu', /Last login:/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 3 — SSH by hostname (DNS / /etc/hosts resolution) ────────

describe('§3 — SSH by hostname rather than IP', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'short device name resolves: ssh alice@pc2',
      on: l => l.pc1,
      cmd: 'ssh alice@pc2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Could not resolve hostname/],
    },
    {
      name: 'short server name resolves: ssh alice@srv1',
      on: l => l.pc1,
      cmd: 'ssh alice@srv1',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'fully-qualified resolution falls back to short name',
      on: l => l.pc1,
      cmd: 'ssh alice@srv1.lan',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: '/etc/hosts entry on the client makes nickname resolvable',
      setup: (l) => { void l.pc1.executeCommand('echo "10.0.0.10 oracledb oracledb.local" >> /etc/hosts'); },
      on: l => l.pc1,
      cmd: 'ssh alice@oracledb',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'unknown name yields "Could not resolve hostname"',
      on: l => l.pc1,
      cmd: 'ssh alice@nope.invalid',
      contains: [/Could not resolve hostname/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'IPv4 address takes precedence over name lookup',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 4 — SSH failure: unreachable / malformed target ──────────

describe('§4 — SSH connection failures: address / target', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'IP off-topology returns "Could not resolve hostname"',
      on: l => l.pc1,
      cmd: 'ssh alice@192.0.2.99',
      contains: [/Could not resolve hostname|No route to host/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'IPv4 with octet > 255 is rejected',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.999',
      contains: [/Could not resolve hostname/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'Empty hostname yields usage',
      on: l => l.pc1,
      cmd: 'ssh',
      contains: [/usage:\s*ssh/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'Only options (no host) yields usage',
      on: l => l.pc1,
      cmd: 'ssh -v -q',
      contains: [/usage:\s*ssh/],
    },
    {
      name: 'Pure whitespace target is treated as missing',
      on: l => l.pc1,
      cmd: 'ssh    ',
      contains: [/usage:\s*ssh/],
    },
    {
      name: 'Garbage hostname with spaces is rejected',
      on: l => l.pc1,
      cmd: 'ssh "alice@bad host"',
      contains: [/Could not resolve hostname|invalid/],
    },
    {
      name: 'Localhost when sshd is up actually connects',
      on: l => l.pc1,
      cmd: 'ssh alice@127.0.0.1',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
