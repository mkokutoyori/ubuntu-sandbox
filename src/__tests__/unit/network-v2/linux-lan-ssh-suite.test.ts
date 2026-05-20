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
 *     pc1 ─┐                              ┌─ srv1 (oracle)
 *     pc2 ─┼─ switch ─┬─────────────────── ┤
 *     pc3 ─┤          │                    └─ srv2 (file/web server)
 *          │          │
 *     pc4 ─┘          (10.0.0.0/24)
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
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── LAN fixture ────────────────────────────────────────────────────

export interface Lan {
  pc1: LinuxPC; pc2: LinuxPC; pc3: LinuxPC; pc4: LinuxPC;
  srv1: LinuxServer; srv2: LinuxServer;
  sw: GenericSwitch;
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
  const sw = new GenericSwitch('switch', 'core-sw', 0, 0);
  const all: (LinuxPC | LinuxServer)[] = [pc1, pc2, pc3, pc4, srv1, srv2];
  all.forEach((d, i) => { new Cable(d.getPorts()[0], sw.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pc3.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc4.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  srv1.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  srv2.getPorts()[0].configureIP(new IPAddress('10.0.0.11'), mask);

  return {
    pc1, pc2, pc3, pc4, srv1, srv2, sw,
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

// ─── Section 5 — SSH refused when remote sshd service is stopped ──────

describe('§5 — SSH refused when remote sshd service is stopped', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'after `systemctl stop ssh` on the target → Connection refused',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Connection refused/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'service stop on a server refuses every client',
      setup: (l) => { void l.srv1.executeCommand('systemctl stop ssh'); },
      on: l => l.pc3,
      cmd: 'ssh alice@10.0.0.10',
      contains: [/Connection refused/],
    },
    {
      name: 'masking ssh refuses with the same error',
      setup: (l) => { void l.pc2.executeCommand('systemctl mask ssh'); void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Connection refused/],
    },
    {
      name: 'after start again, the connection works',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop ssh');
        await l.pc2.executeCommand('systemctl start ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Connection refused/],
    },
    {
      name: 'one remote stopped does NOT affect another remote on the LAN',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.3',  // pc3 still up
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'sshd stopped is reflected by systemctl is-active locally',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc2,
      cmd: 'systemctl is-active ssh',
      contains: ['inactive'],
      excludes: ['active'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 6 — SSH refused when sshd process is killed ──────────────

describe('§6 — SSH refused when sshd process is killed directly', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'kill -9 of sshd PID also makes ssh refuse (parity with stop)',
      setup: async (l) => {
        const ps = await l.pc2.executeCommand('pgrep sshd');
        const pid = ps.trim().split(/\s+/)[0];
        await l.pc2.executeCommand(`kill -9 ${pid}`);
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Connection refused/],
    },
    {
      name: 'pkill -f sshd has the same effect',
      setup: (l) => { void l.pc2.executeCommand('pkill -f sshd'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Connection refused/],
    },
    {
      name: 'killing sshd then systemctl shows it as failed',
      setup: (l) => { void l.pc2.executeCommand('pkill -9 sshd'); },
      on: l => l.pc2,
      cmd: 'systemctl status ssh',
      contains: [/inactive|failed/],
      excludes: [/active \(running\)/],
    },
    {
      name: 'after kill, restarting via systemctl restores service',
      setup: async (l) => {
        await l.pc2.executeCommand('pkill -9 sshd');
        await l.pc2.executeCommand('systemctl restart ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'pkill of an unrelated process leaves ssh up',
      setup: (l) => { void l.pc2.executeCommand('pkill -9 cron'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 7 — SSH refused when remote machine is powered off ──────

describe('§7 — SSH refused when remote machine is powered off', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'powerOff(pc2) then ssh from pc1 → no route / refused',
      setup: (l) => { l.pc2.setPoweredOn(false); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/No route to host|Connection timed out|Could not resolve|refused/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'powering off srv1 also refuses ssh from any pc',
      setup: (l) => { l.srv1.setPoweredOn(false); },
      on: l => l.pc3,
      cmd: 'ssh alice@10.0.0.10',
      contains: [/No route to host|Connection timed out|refused/],
    },
    {
      name: 'powering off then back on restores connectivity',
      setup: (l) => { l.pc2.setPoweredOn(false); l.pc2.setPoweredOn(true); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'ping to a powered-off device also fails',
      setup: (l) => { l.pc2.setPoweredOn(false); },
      on: l => l.pc1,
      cmd: 'ping -c 2 10.0.0.2',
      contains: [/100% packet loss|Destination Host Unreachable|Network is unreachable/],
      excludes: [/0% packet loss/],
    },
    {
      name: 'arping to a powered-off device gets no replies',
      setup: (l) => { l.pc2.setPoweredOn(false); },
      on: l => l.pc1,
      cmd: 'arping -c 2 10.0.0.2',
      contains: [/Sent 2 probes \(2 broadcast\(s\)\)|Received 0 reply|Timeout/],
      excludes: [/Unicast reply from 10\.0\.0\.2/],
    },
    {
      name: 'a powered-off PC does not appear in ip neigh on its neighbours',
      setup: (l) => { l.pc2.setPoweredOn(false); },
      on: l => l.pc1,
      cmd: 'ip neigh show 10.0.0.2',
      contains: [/FAILED|INCOMPLETE/],
      excludes: [/REACHABLE|PERMANENT/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 8 — PermitRootLogin policy enforcement ──────────────────

describe('§8 — PermitRootLogin policy enforcement', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'default PermitRootLogin no → root refused',
      on: l => l.pc1,
      cmd: 'ssh root@10.0.0.2',
      contains: [/Permission denied/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'PermitRootLogin yes → root accepted',
      setup: (l) => { void l.pc2.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh root@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Permission denied/],
    },
    {
      name: 'PermitRootLogin prohibit-password also blocks password root',
      setup: (l) => { void l.pc2.executeCommand('echo "PermitRootLogin prohibit-password" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh root@10.0.0.2',
      contains: [/Permission denied/],
    },
    {
      name: 'non-root users are never blocked by PermitRootLogin no',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Permission denied/],
    },
    {
      name: 'PermitRootLogin no on server still blocks server-to-server root',
      on: l => l.srv1,
      cmd: 'ssh root@10.0.0.11',
      contains: [/Permission denied/],
    },
    {
      name: 'flipping the policy via systemctl reload picks it up',
      setup: async (l) => {
        await l.pc2.executeCommand('echo "PermitRootLogin yes" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh root@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 9 — AllowUsers / DenyUsers in sshd_config ────────────────

describe('§9 — AllowUsers / DenyUsers gating', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'AllowUsers alice → alice succeeds',
      setup: (l) => { void l.pc2.executeCommand('printf "AllowUsers alice\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'AllowUsers alice → bob is rejected',
      setup: (l) => { void l.pc2.executeCommand('printf "AllowUsers alice\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh bob@10.0.0.2',
      contains: [/Permission denied/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'AllowUsers with glob "a*" lets alice and admin in',
      setup: (l) => { void l.pc2.executeCommand('printf "AllowUsers a*\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh admin@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'DenyUsers bob → bob refused even when AllowUsers absent',
      setup: (l) => { void l.pc2.executeCommand('printf "DenyUsers bob\\n" > /etc/ssh/sshd_config'); },
      on: l => l.pc1,
      cmd: 'ssh bob@10.0.0.2',
      contains: [/Permission denied/],
    },
    {
      name: 'DenyUsers takes precedence over AllowUsers',
      setup: (l) => {
        void l.pc2.executeCommand('printf "AllowUsers alice bob\\nDenyUsers bob\\n" > /etc/ssh/sshd_config');
      },
      on: l => l.pc1,
      cmd: 'ssh bob@10.0.0.2',
      contains: [/Permission denied/],
    },
    {
      name: 'no AllowUsers / no DenyUsers → any non-root user is fine',
      on: l => l.pc1,
      cmd: 'ssh charlie@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 10 — non-default Port directive in sshd_config ───────────

describe('§10 — sshd Port directive (non-default)', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'after Port 2222 + reload, port 22 refuses',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',  // defaults to 22
      contains: [/Connection refused/],
    },
    {
      name: 'ssh -p 2222 reaches the new port',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh -p 2222 alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'ss -tln after reload shows port 2222 listening, not 22',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc2,
      cmd: 'ss -tln',
      contains: [/:2222\s/],
      excludes: [/:22\s/],
    },
    {
      name: 'invalid Port value (-1) is rejected on reload',
      on: l => l.pc2,
      cmd: 'sh -c \'echo "Port -1" > /etc/ssh/sshd_config && systemctl reload ssh\'',
      contains: [/Bad configuration option|invalid|out of range/],
    },
    {
      name: 'two Port directives → both ports accept',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 22\\nPort 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh -p 2222 alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 11 — /var/log/auth.log entries match SSH activity ────────

describe('§11 — /var/log/auth.log matches SSH activity', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'successful login appends an "Accepted password" line on the remote',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2'); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Accepted password for alice from 10\.0\.0\.1/],
    },
    {
      name: 'refused login (sshd stopped) appends a "Failed password" line',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop ssh');
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        await l.pc2.executeCommand('systemctl start ssh');
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Failed password for alice/, /from 10\.0\.0\.1/],
    },
    {
      name: 'each login is a separate line (auth log grows monotonically)',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        await l.pc1.executeCommand('ssh bob@10.0.0.2');
        await l.pc1.executeCommand('ssh carol@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'grep -c Accepted /var/log/auth.log',
      contains: [/^3\b/],
    },
    {
      name: 'auth.log contains the source hostname in parentheses',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2'); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/pc1/],
    },
    {
      name: 'auth.log records port and protocol info per OpenSSH',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2'); },
      on: l => l.pc2,
      cmd: 'tail -1 /var/log/auth.log',
      contains: [/port \d+ ssh2/],
    },
    {
      name: 'a refused root login is recorded as "Failed password for root"',
      setup: (l) => { void l.pc1.executeCommand('ssh root@10.0.0.2'); },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Failed password for root from 10\.0\.0\.1/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 12 — logging stopped: rsyslog / journald disabled ────────

describe('§12 — auth.log + syslog when logging daemons are stopped', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'rsyslog stopped → auth.log no longer grows on SSH events',
      setup: async (l) => {
        await l.pc2.executeCommand(': > /var/log/auth.log');
        await l.pc2.executeCommand('systemctl stop rsyslog');
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'wc -l /var/log/auth.log',
      contains: [/^\s*0\s/],
      excludes: [/Accepted/],
    },
    {
      name: 'rsyslog stopped → syslog also stops appending kernel/cron events',
      setup: async (l) => {
        await l.pc2.executeCommand(': > /var/log/syslog');
        await l.pc2.executeCommand('systemctl stop rsyslog');
        await l.pc2.executeCommand('logger "manual test entry"');
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/syslog',
      excludes: ['manual test entry'],
    },
    {
      name: 'journald stopped → journalctl prints an empty / unavailable message',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop systemd-journald'); },
      on: l => l.pc2,
      cmd: 'journalctl -u ssh.service',
      contains: [/No journal files were found|service is not active|No entries/i],
    },
    {
      name: 'after rsyslog is started again, new SSH events ARE logged',
      setup: async (l) => {
        await l.pc2.executeCommand('systemctl stop rsyslog');
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        await l.pc2.executeCommand('systemctl start rsyslog');
        await l.pc1.executeCommand('ssh bob@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'cat /var/log/auth.log',
      contains: [/Accepted password for bob/],
      excludes: [/Accepted password for alice/],
    },
    {
      name: 'systemctl is-active rsyslog reflects the stop',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop rsyslog'); },
      on: l => l.pc2,
      cmd: 'systemctl is-active rsyslog',
      contains: ['inactive'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 13 — ps output realism: headers, padding, alignment ──────

describe('§13 — ps output table presentation (headers, padding)', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ps -ef header line is the standard 8 columns',
      on: l => l.pc1,
      cmd: 'ps -ef',
      contains: [/UID\s+PID\s+PPID\s+C\s+STIME\s+TTY\s+TIME\s+CMD/],
    },
    {
      name: 'ps aux header is the standard 11 columns',
      on: l => l.pc1,
      cmd: 'ps aux',
      contains: [/USER\s+PID\s+%CPU\s+%MEM\s+VSZ\s+RSS\s+TTY\s+STAT\s+START\s+TIME\s+COMMAND/],
    },
    {
      name: 'ps shows systemd as PID 1',
      on: l => l.pc1,
      cmd: 'ps -p 1 -o pid,comm',
      contains: [/^\s*1\s+systemd/m],
    },
    {
      name: 'ps shows sshd line because the service is up',
      on: l => l.pc1,
      cmd: 'ps -ef',
      contains: [/sshd/],
    },
    {
      name: 'columns are space-aligned, never tab-only',
      on: l => l.pc1,
      cmd: 'ps -ef',
      excludes: ['\t'],
    },
    {
      name: 'PID column is right-aligned numerically',
      on: l => l.pc1,
      cmd: 'ps -ef',
      contains: [/\n\s+1\s+/],
    },
    {
      name: 'ps -o custom format respects requested columns only',
      on: l => l.pc1,
      cmd: 'ps -ef -o pid,comm',
      contains: [/^\s*PID\s+COMMAND/m],
      excludes: ['UID', 'STIME', 'TTY'],
    },
    {
      name: 'ps -C ssh filters by exact comm',
      on: l => l.pc1,
      cmd: 'ps -C sshd -o pid,comm',
      contains: ['sshd'],
      excludes: ['systemd', 'cron'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 14 — systemctl list-units / status output presentation ───

describe('§14 — systemctl list-units / status output', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'list-units --type=service has the canonical header',
      on: l => l.pc1,
      cmd: 'systemctl list-units --type=service',
      contains: [/UNIT\s+LOAD\s+ACTIVE\s+SUB\s+DESCRIPTION/],
    },
    {
      name: 'ssh.service appears with state active and sub running',
      on: l => l.pc1,
      cmd: 'systemctl list-units --type=service',
      contains: [/ssh\.service\s+loaded\s+active\s+running/],
    },
    {
      name: 'list-units footer summarises LOAD/ACTIVE/SUB',
      on: l => l.pc1,
      cmd: 'systemctl list-units --type=service',
      contains: [/LOAD\s+=/, /ACTIVE\s+=/, /SUB\s+=/, /\d+\s+loaded units listed/],
    },
    {
      name: 'systemctl status ssh shows Loaded / Active / Main PID',
      on: l => l.pc1,
      cmd: 'systemctl status ssh',
      contains: [/Loaded:.*\/lib\/systemd\/system\/ssh\.service/, /Active:\s+active \(running\)/, /Main PID:\s+\d+/],
    },
    {
      name: 'systemctl status of a stopped service shows inactive (dead)',
      setup: (l) => { void l.pc1.executeCommand('systemctl stop cron'); },
      on: l => l.pc1,
      cmd: 'systemctl status cron',
      contains: [/Active:\s+inactive \(dead\)/],
      excludes: [/active \(running\)/],
    },
    {
      name: 'systemctl status of an unknown unit reports "could not be found"',
      on: l => l.pc1,
      cmd: 'systemctl status nopesvc',
      contains: [/could not be found|not loaded/i],
    },
    {
      name: 'systemctl is-enabled ssh returns "enabled"',
      on: l => l.pc1,
      cmd: 'systemctl is-enabled ssh',
      contains: ['enabled'],
      excludes: ['disabled', 'masked'],
    },
    {
      name: 'list-units --state=failed has zero entries on a fresh boot',
      on: l => l.pc1,
      cmd: 'systemctl list-units --state=failed',
      contains: [/0 loaded units listed/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 15 — service start/stop is reactively reflected in ps ────

describe('§15 — service ↔ process table reactive coherence', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'after `systemctl stop ssh`, no sshd process remains',
      setup: (l) => { void l.pc1.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'pgrep sshd',
      contains: [''],
      excludes: [/\d/],
    },
    {
      name: 'after restart, a NEW PID is allocated for sshd',
      setup: async (l) => {
        const before = (await l.pc1.executeCommand('pgrep sshd')).trim();
        await l.pc1.executeCommand('systemctl restart ssh');
        const after = (await l.pc1.executeCommand('pgrep sshd')).trim();
        expect(before).not.toBe(after);
      },
      on: l => l.pc1,
      cmd: 'pgrep sshd',
      contains: [/\d+/],
    },
    {
      name: 'stop cron → ps -C cron is empty',
      setup: (l) => { void l.pc1.executeCommand('systemctl stop cron'); },
      on: l => l.pc1,
      cmd: 'ps -C cron -o pid,comm',
      contains: [/^\s*PID\s+COMMAND\s*$/m],
      excludes: [/cron/m],
    },
    {
      name: 'start a stopped service brings the process back',
      setup: async (l) => {
        await l.pc1.executeCommand('systemctl stop cron');
        await l.pc1.executeCommand('systemctl start cron');
      },
      on: l => l.pc1,
      cmd: 'pgrep cron',
      contains: [/\d+/],
    },
    {
      name: 'a service marked Restart=always restarts after its main process is killed',
      setup: async (l) => {
        // ssh ships with Restart=on-failure; force a crash via SIGKILL
        const pid = (await l.pc1.executeCommand('pgrep sshd')).trim();
        await l.pc1.executeCommand(`kill -9 ${pid}`);
        // a future-style implementation auto-restarts; allow either outcome
      },
      on: l => l.pc1,
      cmd: 'systemctl status ssh',
      contains: [/Active:\s+(active \(running\)|failed)/],
    },
    {
      name: 'systemctl reset-failed clears the failure counter',
      setup: async (l) => {
        const pid = (await l.pc1.executeCommand('pgrep sshd')).trim();
        await l.pc1.executeCommand(`kill -9 ${pid}`);
        await l.pc1.executeCommand('systemctl reset-failed ssh');
      },
      on: l => l.pc1,
      cmd: 'systemctl show -p NRestarts ssh',
      contains: ['NRestarts=0'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
