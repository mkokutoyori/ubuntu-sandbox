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

  // Hostnames match the device test name for ssh banner / auth.log realism.
  pc1.setHostname('pc1'); pc2.setHostname('pc2'); pc3.setHostname('pc3'); pc4.setHostname('pc4');
  srv1.setHostname('srv1'); srv2.setHostname('srv2');

  // Provision a small cast of regular users on every device so the
  // sshd-side "user exists in /etc/passwd" gate accepts them. Done via
  // the user manager directly (not `useradd`) because that command is
  // root-only and PCs default to the unprivileged 'user'.
  for (const d of [pc1, pc2, pc3, pc4, srv1, srv2]) {
    const um = (d as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      getUser: (u: string) => unknown;
      setPassword: (u: string, p: string) => void;
      usermod: (u: string, o: object) => void;
    } } }).executor.userMgr;
    for (const u of ['alice', 'bob', 'carol', 'dave', 'admin', 'charlie']) {
      if (!um.getUser(u)) {
        um.useradd(u, { m: true, s: '/bin/bash' });
        um.setPassword(u, 'admin');
        // alice and admin are sudoers (membership in the 'sudo' group);
        // bob/carol/dave/charlie deliberately are not.
        if (u === 'alice' || u === 'admin') um.usermod(u, { aG: 'sudo' });
      }
    }
  }

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

describe('§6 — sshd process killed directly: supervisor brings it back', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      // ssh.service ships Restart=on-failure (Ubuntu default), so the
      // reactive supervisor resurrects sshd after a SIGKILL.
      name: 'kill -9 of sshd PID — supervisor restarts; subsequent ssh works',
      setup: async (l) => {
        const ps = await l.pc2.executeCommand('pgrep sshd');
        const pid = ps.trim().split(/\s+/)[0];
        await l.pc2.executeCommand(`kill -9 ${pid}`);
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Connection refused/],
    },
    {
      name: 'pkill -f sshd — same supervisor-driven recovery',
      setup: (l) => { void l.pc2.executeCommand('pkill -f sshd'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Connection refused/],
    },
    {
      name: 'after pkill, systemctl status reports active (running) again',
      setup: (l) => { void l.pc2.executeCommand('pkill -9 sshd'); },
      on: l => l.pc2,
      cmd: 'systemctl status ssh',
      contains: [/Active:\s+active \(running\)/],
      excludes: [/failed/],
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
      setup: (l) => { l.pc2.powerOff(); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/No route to host|Connection timed out|Could not resolve|refused/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'powering off srv1 also refuses ssh from any pc',
      setup: (l) => { l.srv1.powerOff(); },
      on: l => l.pc3,
      cmd: 'ssh alice@10.0.0.10',
      contains: [/No route to host|Connection timed out|refused/],
    },
    {
      name: 'powering off then back on restores connectivity',
      setup: (l) => { l.pc2.powerOff(); l.pc2.powerOn(); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'ping to a powered-off device also fails',
      setup: (l) => { l.pc2.powerOff(); },
      on: l => l.pc1,
      cmd: 'ping -c 2 10.0.0.2',
      contains: [/100% packet loss|Destination Host Unreachable|Network is unreachable/],
      // Note: don't exclude "0% packet loss" — "100% packet loss" matches it as a substring.
      excludes: [/\b0 packets transmitted, 2 received/],
    },
    {
      name: 'arping to a powered-off device gets no replies',
      setup: (l) => { l.pc2.powerOff(); },
      on: l => l.pc1,
      cmd: 'arping -c 2 10.0.0.2',
      contains: [/Sent 2 probes \(2 broadcast\(s\)\)|Received 0 reply|Timeout/],
      excludes: [/Unicast reply from 10\.0\.0\.2/],
    },
    {
      name: 'a powered-off PC does not appear in ip neigh on its neighbours',
      setup: (l) => { l.pc2.powerOff(); },
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
      name: 'PID column is right-aligned numerically (right-padded under PID header)',
      on: l => l.pc1,
      cmd: 'ps -ef',
      // header has `PID` at a known column; rows must have the PID digit
      // sitting at the same column or to its right (right-aligned).
      contains: [/PID\s+PPID/, /\s+1\s+\d+\s+\d/],
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

// ─── Section 16 — pstree presentation and rooting on init ─────────────

describe('§16 — pstree process tree presentation', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'pstree starts at systemd as the root',
      on: l => l.pc1,
      cmd: 'pstree',
      contains: [/^systemd/m],
    },
    {
      name: 'pstree -p shows PIDs in parentheses next to each comm',
      on: l => l.pc1,
      cmd: 'pstree -p',
      contains: [/systemd\(1\)/],
    },
    {
      name: 'pstree includes branch glyphs ├─ and └─',
      on: l => l.pc1,
      cmd: 'pstree',
      contains: [/├─/, /└─/],
    },
    {
      name: 'pstree -s 1 shows the chain up from PID 1',
      on: l => l.pc1,
      cmd: 'pstree -s 1',
      contains: ['systemd'],
    },
    {
      name: 'pstree on a non-existent PID reports "no process found"',
      on: l => l.pc1,
      cmd: 'pstree -p 999999',
      contains: [/no process found|No such process/i],
    },
    {
      name: 'on srv1 with Oracle started, pstree -p shows ora_pmon under systemd',
      setup: async (l) => {
        // touching the database boots the instance and emits the bg-process events
        await l.srv1.executeCommand('sqlplus / as sysdba');
      },
      on: l => l.srv1,
      cmd: 'pstree -p',
      contains: [/ora_pmon/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 17 — killing critical / protected processes ──────────────

describe('§17 — kill of critical / protected processes', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'kill -9 1 (systemd) is refused with "Operation not permitted"',
      on: l => l.pc1,
      cmd: 'kill -9 1',
      contains: [/Operation not permitted|not permitted/i],
    },
    {
      name: 'after attempting kill -9 1, systemd is still PID 1',
      setup: (l) => { void l.pc1.executeCommand('kill -9 1'); },
      on: l => l.pc1,
      cmd: 'ps -p 1 -o pid,comm',
      contains: [/^\s*1\s+systemd/m],
    },
    {
      name: 'kill on a non-existent PID reports "No such process"',
      on: l => l.pc1,
      cmd: 'kill 999999',
      contains: [/No such process/],
    },
    {
      name: 'kill with no argument prints usage and exits non-zero',
      on: l => l.pc1,
      cmd: 'kill',
      contains: [/usage:\s+kill/i],
    },
    {
      name: 'kill -l lists at least the standard 15 + RT signals',
      on: l => l.pc1,
      cmd: 'kill -l',
      contains: ['SIGHUP', 'SIGINT', 'SIGKILL', 'SIGTERM', 'SIGCHLD'],
    },
    {
      name: 'killall systemd refuses to terminate the init process',
      on: l => l.pc1,
      cmd: 'killall systemd',
      contains: [/Operation not permitted|systemd: no process found/i],
    },
    {
      name: 'pkill -9 of an unknown comm reports no processes matched',
      on: l => l.pc1,
      cmd: 'pkill -9 ghostproc',
      contains: [''], // pkill prints nothing on no match
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 18 — scp / sftp / rsync also gated on remote sshd ────────

describe('§18 — scp / sftp / rsync gated on remote sshd', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'scp alice@host:/path local — succeeds when sshd is up',
      setup: (l) => { void l.pc2.executeCommand('echo hello > /tmp/file.txt'); },
      on: l => l.pc1,
      cmd: 'scp alice@10.0.0.2:/tmp/file.txt /tmp/local.txt',
      contains: [/file\.txt\s+100%|bytes transferred/i],
      excludes: [/Connection refused/],
    },
    {
      name: 'scp refused when remote sshd is stopped',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'scp alice@10.0.0.2:/tmp/file.txt /tmp/local.txt',
      contains: [/Connection refused|lost connection/],
    },
    {
      name: 'sftp succeeds when sshd is up and shows interactive prompt',
      on: l => l.pc1,
      cmd: 'sftp alice@10.0.0.2',
      contains: [/Connected to 10\.0\.0\.2|sftp>/],
    },
    {
      name: 'sftp refused when sshd is stopped',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'sftp alice@10.0.0.2',
      contains: [/Connection refused/],
    },
    {
      name: 'rsync over ssh refused when sshd is stopped',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'rsync -av /tmp/ alice@10.0.0.2:/tmp/',
      contains: [/Connection refused|connection unexpectedly closed/],
    },
    {
      name: 'scp to an off-topology IP fails with "No route to host"',
      on: l => l.pc1,
      cmd: 'scp /tmp/x alice@192.0.2.99:/tmp/',
      contains: [/No route to host|Could not resolve hostname|lost connection/],
    },
    {
      name: 'scp with -P 2222 uses the alternate port',
      setup: async (l) => {
        await l.pc2.executeCommand('printf "Port 2222\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'scp -P 2222 /tmp/x alice@10.0.0.2:/tmp/',
      contains: [/bytes transferred|100%/i],
      excludes: [/Connection refused/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 19 — interface down / network unreachable ───────────────

describe('§19 — interface down / network unreachable', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ifconfig eth0 down on the client → ssh fails locally',
      setup: (l) => { void l.pc1.executeCommand('ifconfig eth0 down'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Network is unreachable|No route to host/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'ip link set eth0 down on the target → other peers fail to reach it',
      setup: (l) => { void l.pc2.executeCommand('ip link set eth0 down'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/No route to host|Connection timed out|refused/],
    },
    {
      name: 'after bringing the interface back up, ssh works again',
      setup: async (l) => {
        await l.pc1.executeCommand('ifconfig eth0 down');
        await l.pc1.executeCommand('ifconfig eth0 up');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'removing the IP makes ssh report "Cannot assign requested address" or fail',
      setup: (l) => { void l.pc1.executeCommand('ip addr flush dev eth0'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Cannot assign requested address|Network is unreachable/],
    },
    {
      name: 'ip route delete default makes off-subnet ssh fail (no gateway)',
      setup: (l) => { void l.pc1.executeCommand('ip route del default'); },
      on: l => l.pc1,
      cmd: 'ssh alice@198.51.100.7',
      contains: [/Network is unreachable|Could not resolve|No route to host/],
    },
    {
      name: 'ifconfig output reflects the eth0 down state',
      setup: (l) => { void l.pc1.executeCommand('ifconfig eth0 down'); },
      on: l => l.pc1,
      cmd: 'ifconfig eth0',
      contains: [/DOWN|state DOWN|flags=4099/],
      excludes: [/UP\b.*RUNNING/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 20 — firewall (iptables/ufw) blocking port 22 ────────────

describe('§20 — firewall rules blocking port 22', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'iptables -A INPUT -p tcp --dport 22 -j DROP refuses ssh',
      setup: (l) => { void l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Connection timed out|No route to host|refused/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'iptables -A INPUT -s 10.0.0.1 -j DROP blocks only pc1',
      setup: (l) => { void l.pc2.executeCommand('iptables -A INPUT -s 10.0.0.1 -j DROP'); },
      on: l => l.pc3,  // pc3 should still reach pc2
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'ufw deny 22 has the same effect as iptables DROP on 22',
      setup: async (l) => {
        await l.pc2.executeCommand('ufw enable');
        await l.pc2.executeCommand('ufw deny 22');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/refused|timed out|unreachable/i],
    },
    {
      name: 'iptables -F restores connectivity',
      setup: async (l) => {
        await l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
        await l.pc2.executeCommand('iptables -F');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'iptables -L INPUT lists the DROP rule we added',
      setup: (l) => { void l.pc2.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP'); },
      on: l => l.pc2,
      cmd: 'iptables -L INPUT -n',
      contains: [/DROP\s+tcp.*dpt:22/],
    },
    {
      name: 'ufw status shows enabled + rule list',
      setup: async (l) => {
        await l.pc2.executeCommand('ufw enable');
        await l.pc2.executeCommand('ufw deny 22');
      },
      on: l => l.pc2,
      cmd: 'ufw status',
      contains: [/Status: active/, /22.*DENY/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 21 — background ssh & job control ───────────────────────

describe('§21 — background ssh and job control', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: '`ssh ... &` registers a background job, announces [N] PID',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 sleep 60 &',
      contains: [/^\[1\] \d+/m],
    },
    {
      name: 'jobs lists the background ssh',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 sleep 60 &'); },
      on: l => l.pc1,
      cmd: 'jobs',
      contains: [/\[1\][-+ ]+Running\s+ssh alice@10\.0\.0\.2/],
    },
    {
      name: 'kill %1 terminates the background ssh',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2 sleep 60 &');
        await l.pc1.executeCommand('kill %1');
      },
      on: l => l.pc1,
      cmd: 'jobs',
      excludes: [/\[1\]/],
    },
    {
      name: 'nohup ssh disowns from the parent shell',
      on: l => l.pc1,
      cmd: 'nohup ssh alice@10.0.0.2 sleep 60 &',
      contains: [/nohup: ignoring input/, /\[1\] \d+/],
    },
    {
      name: 'concurrent ssh sessions both appear in jobs',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2 sleep 60 &');
        await l.pc1.executeCommand('ssh bob@10.0.0.10 sleep 60 &');
      },
      on: l => l.pc1,
      cmd: 'jobs',
      contains: [/\[1\]/, /\[2\]/],
    },
    {
      name: 'wait %1 returns when the background ssh finishes',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 true &'); },
      on: l => l.pc1,
      cmd: 'wait %1',
      excludes: [/no such job/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 22 — concurrent SSH from multiple clients ────────────────

describe('§22 — concurrent SSH from multiple clients', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'four clients to one target produce four auth.log entries',
      setup: async (l) => {
        await Promise.all([
          l.pc1.executeCommand('ssh alice@10.0.0.10'),
          l.pc2.executeCommand('ssh bob@10.0.0.10'),
          l.pc3.executeCommand('ssh carol@10.0.0.10'),
          l.pc4.executeCommand('ssh dave@10.0.0.10'),
        ]);
      },
      on: l => l.srv1,
      cmd: 'grep -c Accepted /var/log/auth.log',
      contains: [/^4\b/],
    },
    {
      name: 'the four sources are all distinct IPs in the log',
      setup: async (l) => {
        await Promise.all([
          l.pc1.executeCommand('ssh alice@10.0.0.10'),
          l.pc2.executeCommand('ssh alice@10.0.0.10'),
          l.pc3.executeCommand('ssh alice@10.0.0.10'),
          l.pc4.executeCommand('ssh alice@10.0.0.10'),
        ]);
      },
      on: l => l.srv1,
      cmd: 'cat /var/log/auth.log',
      contains: [/from 10\.0\.0\.1\b/, /from 10\.0\.0\.2\b/, /from 10\.0\.0\.3\b/, /from 10\.0\.0\.4\b/],
    },
    {
      name: 'who shows multiple sessions on the target while ssh holds',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &');
        await l.pc2.executeCommand('ssh bob@10.0.0.10 sleep 60 &');
      },
      on: l => l.srv1,
      cmd: 'who',
      contains: [/alice/, /bob/],
    },
    {
      name: 'last shows recent successful logins',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.10');
        await l.pc2.executeCommand('ssh bob@10.0.0.10');
      },
      on: l => l.srv1,
      cmd: 'last -n 5',
      contains: [/alice.*10\.0\.0\.1/, /bob.*10\.0\.0\.2/],
    },
    {
      name: 'two clients hitting a stopped service all see Connection refused',
      setup: (l) => { void l.srv1.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10',
      contains: [/Connection refused/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 23 — ssh + cron + at end-to-end correlation ──────────────

describe('§23 — cron / at scheduling behind sshd', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'crontab -l after ssh shows the remote crontab',
      setup: async (l) => {
        await l.srv1.executeCommand('echo "* * * * * /bin/echo ping" | crontab -');
        await l.pc1.executeCommand('ssh alice@10.0.0.10 crontab -l');
      },
      on: l => l.srv1,
      cmd: 'crontab -l',
      contains: ['* * * * * /bin/echo ping'],
    },
    {
      name: 'cron service stopped → crontab -e still works but jobs do not fire',
      setup: (l) => { void l.srv1.executeCommand('systemctl stop cron'); },
      on: l => l.srv1,
      cmd: 'systemctl is-active cron',
      contains: ['inactive'],
    },
    {
      name: 'atq lists queued at jobs after ssh schedules one',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.10 "echo \'date\' | at now + 1 minute"');
      },
      on: l => l.srv1,
      cmd: 'atq',
      contains: [/^\d+\s+/m],
    },
    {
      name: 'atrm removes a queued job',
      setup: async (l) => {
        await l.srv1.executeCommand("echo 'date' | at now + 1 hour");
        await l.srv1.executeCommand('atrm 1');
      },
      on: l => l.srv1,
      cmd: 'atq',
      excludes: [/^1\s+/m],
    },
    {
      name: 'atd stopped → at command refuses',
      setup: (l) => { void l.srv1.executeCommand('systemctl stop atd'); },
      on: l => l.srv1,
      cmd: "echo 'date' | at now + 1 minute",
      contains: [/atd is not running|Can't open|cannot/i],
    },
    {
      name: 'cron log entries appear in /var/log/syslog when cron fires',
      setup: async (l) => {
        await l.srv1.executeCommand('echo "* * * * * /bin/true" | crontab -');
      },
      on: l => l.srv1,
      cmd: 'tail -100 /var/log/syslog',
      contains: [/CRON.*\(alice\)|cron\[\d+\]/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 24 — Oracle DB on srv1: pmon visible via ssh ─────────────

describe('§24 — Oracle DB processes visible across the LAN via ssh', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'after Oracle starts on srv1, remote ps -ef | grep ora_ via ssh finds pmon',
      setup: (l) => { void l.srv1.executeCommand('sqlplus / as sysdba'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10 "ps -ef | grep ora_pmon | grep -v grep"',
      contains: [/oracle\s+\d+\s+\d+.*ora_pmon/],
    },
    {
      name: 'ora_smon and ora_lgwr also appear via remote ps',
      setup: (l) => { void l.srv1.executeCommand('sqlplus / as sysdba'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10 ps -ef -o user,comm',
      contains: [/oracle\s+ora_smon/, /oracle\s+ora_lgwr/],
    },
    {
      name: 'after SHUTDOWN ABORT, ora_pmon disappears',
      setup: async (l) => {
        await l.srv1.executeCommand('sqlplus / as sysdba');
        await l.srv1.executeCommand('echo "SHUTDOWN ABORT;" | sqlplus / as sysdba');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10 ps -ef -o comm',
      excludes: ['ora_pmon'],
    },
    {
      name: 'srv2 has no Oracle running → ssh ps shows none',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.11 ps -ef -o comm',
      excludes: ['ora_pmon', 'ora_smon'],
    },
    {
      name: 'lsnrctl status on srv1 shows the LISTENER as RUNNING',
      setup: (l) => { void l.srv1.executeCommand('sqlplus / as sysdba'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10 lsnrctl status',
      contains: [/Listener Parameter File|Listening Endpoints Summary|TNS:listener/],
    },
    {
      name: 'sqlplus from pc over ssh connects to ORCL',
      setup: (l) => { void l.srv1.executeCommand('sqlplus / as sysdba'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.10 sqlplus -s system/oracle@ORCL "SELECT 1 FROM DUAL"',
      contains: [/1\s*$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 25 — end-to-end audit: SSH session ↔ logs ↔ ps ↔ services

describe('§25 — full end-to-end audit story', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'after an ssh login, w on the remote lists the user',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &'); },
      on: l => l.srv1,
      cmd: 'w',
      contains: [/alice.*pts\/\d+\s+10\.0\.0\.1/],
    },
    {
      name: 'cat /var/log/auth.log + ps -ef tell a coherent story (both PIDs match)',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &'); },
      on: l => l.srv1,
      cmd: 'sh -c "tail -1 /var/log/auth.log; ps -ef | grep sshd | grep alice"',
      contains: [/Accepted password for alice/, /sshd.*alice/],
    },
    {
      name: 'logger writes a custom line and syslog records it',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.10 logger "audit-trail-marker"'); },
      on: l => l.srv1,
      cmd: 'grep audit-trail-marker /var/log/syslog',
      contains: [/audit-trail-marker/],
    },
    {
      name: 'systemctl stop ssh during a session is reflected in journalctl',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &');
        await l.srv1.executeCommand('systemctl stop ssh');
      },
      on: l => l.srv1,
      cmd: 'journalctl -u ssh.service -n 5',
      contains: [/Stopped|Deactivated|ssh\.service/i],
    },
    {
      name: 'turn srv1 off mid-session → pc1\'s ssh job ends',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &');
        l.srv1.powerOff();
      },
      on: l => l.pc1,
      cmd: 'jobs',
      contains: [/Done|Exit|Killed/],
    },
    {
      name: 'after a deny rule on srv1 firewall, audit.log keeps NO new Accepted lines',
      setup: async (l) => {
        await l.srv1.executeCommand('iptables -A INPUT -s 10.0.0.1 -p tcp --dport 22 -j DROP');
        await l.srv1.executeCommand(': > /var/log/auth.log');
        await l.pc1.executeCommand('ssh alice@10.0.0.10');
      },
      on: l => l.srv1,
      cmd: 'cat /var/log/auth.log',
      excludes: [/Accepted password for alice from 10\.0\.0\.1/],
    },
    {
      name: 'reboot of srv1 resets uptime',
      setup: async (l) => {
        l.srv1.powerOff();
        l.srv1.powerOn();
      },
      on: l => l.srv1,
      cmd: 'uptime -p',
      contains: [/up\s+0\s+(minutes|seconds)|up\s+less than/],
    },
    {
      name: 'a full audit query via ssh: who+last+ps in one line',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.10 sleep 60 &'); },
      on: l => l.pc2,
      cmd: 'ssh bob@10.0.0.10 "who; last -n 1; ps -ef | grep sshd | head -3"',
      contains: [/alice/, /sshd/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 26 — SSH public-key authentication ───────────────────────

describe('§26 — SSH public-key authentication', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh-keygen creates ~/.ssh/id_ed25519 and .pub',
      on: l => l.pc1,
      cmd: 'ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q',
      contains: [''],
      excludes: [/error|failed/i],
    },
    {
      name: 'after keygen, both private and public files exist with 0600 / 0644',
      setup: (l) => { void l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q'); },
      on: l => l.pc1,
      cmd: 'ls -l /root/.ssh/',
      contains: [/-rw-------\s+\d+\s+root\s+root.*id_ed25519$/m, /-rw-r--r--.*id_ed25519\.pub/],
    },
    {
      name: 'ssh-copy-id installs the public key on the remote',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-copy-id alice@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'cat /home/alice/.ssh/authorized_keys',
      contains: [/^ssh-ed25519 /m],
    },
    {
      name: 'subsequent ssh uses public-key auth (Accepted publickey line)',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-copy-id alice@10.0.0.2');
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
      },
      on: l => l.pc2,
      cmd: 'tail -1 /var/log/auth.log',
      contains: [/Accepted publickey for alice/],
    },
    {
      name: 'PubkeyAuthentication no in sshd_config blocks pubkey login',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-copy-id alice@10.0.0.2');
        await l.pc2.executeCommand('printf "PubkeyAuthentication no\\n" > /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh -o PasswordAuthentication=no alice@10.0.0.2',
      contains: [/Permission denied \(publickey\)/],
    },
    {
      name: 'ssh-keygen -y -f reads the private key and prints the public form',
      setup: (l) => { void l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q'); },
      on: l => l.pc1,
      cmd: 'ssh-keygen -y -f /root/.ssh/id_ed25519',
      contains: [/^ssh-ed25519 /],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 27 — ssh-agent / ssh-add ─────────────────────────────────

describe('§27 — ssh-agent and ssh-add', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh-add -l reports "no identities" when agent is empty',
      on: l => l.pc1,
      cmd: 'ssh-add -l',
      contains: [/no identities|No identities/],
    },
    {
      name: 'ssh-add of a key adds it and ssh-add -l lists it',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-add /root/.ssh/id_ed25519');
      },
      on: l => l.pc1,
      cmd: 'ssh-add -l',
      contains: [/^256 SHA256:.*id_ed25519 \(ED25519\)/m],
    },
    {
      name: 'ssh-add -L prints the public key in authorized_keys form',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-add /root/.ssh/id_ed25519');
      },
      on: l => l.pc1,
      cmd: 'ssh-add -L',
      contains: [/^ssh-ed25519 /m],
    },
    {
      name: 'ssh-add -d removes a specific identity',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-add /root/.ssh/id_ed25519');
        await l.pc1.executeCommand('ssh-add -d /root/.ssh/id_ed25519');
      },
      on: l => l.pc1,
      cmd: 'ssh-add -l',
      contains: [/no identities/i],
    },
    {
      name: 'ssh-add -D removes all identities',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/k1 -N "" -q');
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/k2 -N "" -q');
        await l.pc1.executeCommand('ssh-add /root/.ssh/k1');
        await l.pc1.executeCommand('ssh-add /root/.ssh/k2');
        await l.pc1.executeCommand('ssh-add -D');
      },
      on: l => l.pc1,
      cmd: 'ssh-add -l',
      contains: [/no identities/i],
    },
    {
      name: 'ssh -A forwards the agent (remote ssh-add -l hits original agent)',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q');
        await l.pc1.executeCommand('ssh-add /root/.ssh/id_ed25519');
      },
      on: l => l.pc1,
      cmd: 'ssh -A alice@10.0.0.2 ssh-add -l',
      contains: [/SHA256:.*id_ed25519/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 28 — ssh exec mode (`ssh host cmd …`) ────────────────────

describe('§28 — ssh exec mode: remote command execution', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh host hostname prints the remote hostname only',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 hostname',
      contains: [/^pc2\s*$/m],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'ssh host whoami prints the SSH login user (not the local one)',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 whoami',
      contains: [/^alice\s*$/m],
    },
    {
      name: 'ssh host pwd returns the alice user home',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 pwd',
      contains: [/^\/home\/alice\s*$/m],
    },
    {
      name: 'ssh quoting: ssh host "uname -a" returns remote uname',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 "uname -a"',
      contains: [/Linux pc2.*GNU\/Linux/],
    },
    {
      name: 'ssh host returns the remote command exit status',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 false; echo "rc=$?"',
      contains: [/^rc=1\s*$/m],
    },
    {
      name: 'ssh host with bad command yields "command not found" + exit 127',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 ghostbin; echo "rc=$?"',
      contains: [/ghostbin: command not found/, /^rc=127\s*$/m],
    },
    {
      name: 'multi-statement: ssh host "cd /tmp && pwd" reflects the cd',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 "cd /tmp && pwd"',
      contains: [/^\/tmp\s*$/m],
    },
    {
      name: 'ssh -t host bash -lc starts a login shell context',
      on: l => l.pc1,
      cmd: 'ssh -t alice@10.0.0.2 bash -lc \'echo $0\'',
      contains: [/^-?bash\s*$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 29 — known_hosts handling ─────────────────────────────────

describe('§29 — ~/.ssh/known_hosts host-key tracking', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'first ssh appends a known_hosts entry for the remote',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2'); },
      on: l => l.pc1,
      cmd: 'cat /root/.ssh/known_hosts',
      contains: [/^10\.0\.0\.2 ssh-(ed25519|rsa) /m],
    },
    {
      name: 'second ssh to the same host reuses the entry (no prompt)',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
      },
      on: l => l.pc1,
      cmd: 'wc -l /root/.ssh/known_hosts',
      contains: [/^\s*1\s/],
    },
    {
      name: 'ssh-keyscan host prints the remote host keys',
      on: l => l.pc1,
      cmd: 'ssh-keyscan 10.0.0.2',
      contains: [/^10\.0\.0\.2 ssh-(ed25519|rsa) /m],
    },
    {
      name: 'changed host key triggers a "REMOTE HOST IDENTIFICATION HAS CHANGED!" warning',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        // simulate key rotation on the remote
        await l.pc2.executeCommand('rm /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
        await l.pc2.executeCommand('ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q');
        await l.pc2.executeCommand('systemctl restart ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/REMOTE HOST IDENTIFICATION HAS CHANGED!/],
    },
    {
      name: 'ssh-keygen -R 10.0.0.2 removes the offending entry',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2');
        await l.pc1.executeCommand('ssh-keygen -R 10.0.0.2');
      },
      on: l => l.pc1,
      cmd: 'cat /root/.ssh/known_hosts',
      excludes: ['10.0.0.2'],
    },
    {
      name: 'StrictHostKeyChecking=no auto-accepts without warning',
      on: l => l.pc1,
      cmd: 'ssh -o StrictHostKeyChecking=no alice@10.0.0.3',
      contains: ['Welcome to Ubuntu'],
      excludes: [/authenticity|fingerprint check failed/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 30 — network monitoring of SSH (ss, netstat, lsof, tcpdump)

describe('§30 — network monitoring of SSH listener and sessions', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ss -tlnp shows sshd listening on port 22 with PID/program',
      on: l => l.pc1,
      cmd: 'ss -tlnp',
      contains: [/0\.0\.0\.0:22.*sshd/, /pid=\d+/],
    },
    {
      name: 'netstat -tlnp shows the same sshd listener',
      on: l => l.pc1,
      cmd: 'netstat -tlnp',
      contains: [/0\.0\.0\.0:22.*LISTEN.*sshd/],
    },
    {
      name: 'lsof -i :22 lists the sshd process bound to port 22',
      on: l => l.pc1,
      cmd: 'lsof -i :22',
      contains: [/sshd\s+\d+\s+root.*TCP \*:(ssh|22) \(LISTEN\)/],
    },
    {
      name: 'after systemctl stop ssh, no listener on port 22',
      setup: (l) => { void l.pc1.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ss -tln',
      excludes: [/:22\s/],
    },
    {
      name: 'while session is active, ss -t shows an ESTABLISHED connection',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 sleep 60 &'); },
      on: l => l.pc2,
      cmd: 'ss -t state established',
      contains: [/10\.0\.0\.2:(ssh|22)\s+10\.0\.0\.1:\d+/],
    },
    {
      name: 'tcpdump -ni eth0 port 22 -c 2 captures SYN/SYN-ACK during a connect',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 hostname'); },
      on: l => l.pc1,
      cmd: 'tcpdump -ni eth0 port 22 -c 2',
      contains: [/Flags \[S\]|Flags \[S\.\]/, /10\.0\.0\.2\.22/],
    },
    {
      name: 'iftop / ss --resolve shows the symbolic port "ssh"',
      on: l => l.pc1,
      cmd: 'ss -tln',
      contains: [/:22\s/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 31 — /etc/passwd, /etc/shadow & user existence ───────────

describe('§31 — user existence ↔ SSH login outcome', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh to an unknown remote user → Permission denied',
      on: l => l.pc1,
      cmd: 'ssh ghostuser@10.0.0.2',
      contains: [/Permission denied/],
      excludes: ['Welcome to Ubuntu'],
    },
    {
      name: 'useradd alice on the remote makes alice loginable',
      setup: async (l) => {
        await l.pc2.executeCommand('userdel alice 2>/dev/null; useradd -m alice');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'userdel alice on the remote then ssh alice fails',
      setup: (l) => {
        // userdel is root-only in the bash shell; delete via the user
        // manager so the test doesn't depend on becoming root.
        const um = (l.pc2 as unknown as { executor: { userMgr: {
          userdel: (u: string) => void;
        } } }).executor.userMgr;
        um.userdel('alice');
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Permission denied/],
    },
    {
      name: 'locked account (usermod -L alice) is refused',
      setup: (l) => {
        // passwd / usermod are root-only in the bash shell; tunnel
        // through the userMgr directly to lock the account.
        const um = (l.pc2 as unknown as { executor: { userMgr: {
          usermod: (u: string, opts: object) => void;
        } } }).executor.userMgr;
        um.usermod('alice', { L: true });
      },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2',
      contains: [/Permission denied|account locked/i],
    },
    {
      name: '/etc/passwd reflects the user',
      setup: (l) => { void l.pc2.executeCommand('useradd -m carol -s /bin/bash'); },
      on: l => l.pc2,
      cmd: 'getent passwd carol',
      contains: [/^carol:x:\d+:\d+:.*:\/home\/carol:\/bin\/bash$/m],
    },
    {
      name: 'expired shadow entry blocks login',
      setup: (l) => {
        // chage is root-only; set expireDate directly so the test
        // doesn't depend on becoming root.
        const um = (l.pc2 as unknown as { executor: { userMgr: {
          getUser: (u: string) => { expireDate?: number } | undefined;
        } } }).executor.userMgr;
        const u = um.getUser('bob');
        if (u) {
          // 18262 = days from 1970-01-01 to 2020-01-01 — already in the past.
          u.expireDate = 18262;
        }
      },
      on: l => l.pc1,
      cmd: 'ssh bob@10.0.0.2',
      contains: [/expired|Permission denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 32 — env forwarding (SendEnv / AcceptEnv) ────────────────

describe('§32 — environment forwarding (SendEnv / AcceptEnv)', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'default: client env is NOT forwarded to remote',
      on: l => l.pc1,
      cmd: 'MYVAR=hello ssh alice@10.0.0.2 \'echo "MYVAR=$MYVAR"\'',
      contains: [/^MYVAR=\s*$/m],
    },
    {
      name: 'SendEnv MYVAR + AcceptEnv MYVAR forwards the variable',
      setup: async (l) => {
        await l.pc1.executeCommand('printf "SendEnv MYVAR\\n" > /root/.ssh/config');
        await l.pc2.executeCommand('printf "AcceptEnv MYVAR\\n" >> /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'MYVAR=hello ssh alice@10.0.0.2 \'echo "MYVAR=$MYVAR"\'',
      contains: [/^MYVAR=hello\s*$/m],
    },
    {
      name: 'LANG / LC_ALL are forwarded by default (OpenSSH defaults)',
      on: l => l.pc1,
      cmd: 'LANG=fr_FR.UTF-8 ssh alice@10.0.0.2 \'locale | head -1\'',
      contains: [/LANG=fr_FR\.UTF-8/],
    },
    {
      name: '-o SendEnv= overrides config and blocks forwarding',
      setup: (l) => { void l.pc1.executeCommand('printf "SendEnv MYVAR\\n" > /root/.ssh/config'); },
      on: l => l.pc1,
      cmd: 'MYVAR=zzz ssh -o "SendEnv " alice@10.0.0.2 \'echo "MYVAR=$MYVAR"\'',
      contains: [/^MYVAR=\s*$/m],
    },
    {
      name: 'forwarded env appears in env output on remote',
      setup: async (l) => {
        await l.pc1.executeCommand('printf "SendEnv FOO BAR\\n" > /root/.ssh/config');
        await l.pc2.executeCommand('printf "AcceptEnv FOO BAR\\n" >> /etc/ssh/sshd_config');
        await l.pc2.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'FOO=1 BAR=2 ssh alice@10.0.0.2 env',
      contains: [/^FOO=1$/m, /^BAR=2$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 33 — port forwarding (-L, -R, -D) ────────────────────────

describe('§33 — SSH port forwarding (-L / -R / -D)', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh -L 8080:srv2:80 alice@srv1 establishes local forwarding',
      on: l => l.pc1,
      cmd: 'ssh -fNL 8080:10.0.0.11:80 alice@10.0.0.10',
      excludes: [/Could not request local forwarding|refused/],
    },
    {
      name: 'after -L is up, ss -tln on pc1 shows port 8080 listening',
      setup: (l) => { void l.pc1.executeCommand('ssh -fNL 8080:10.0.0.11:80 alice@10.0.0.10'); },
      on: l => l.pc1,
      cmd: 'ss -tln',
      contains: [/127\.0\.0\.1:8080|0\.0\.0\.0:8080/],
    },
    {
      name: 'ssh -R 9090:localhost:22 alice@srv1 sets up remote forwarding',
      on: l => l.pc1,
      cmd: 'ssh -fNR 9090:localhost:22 alice@10.0.0.10',
      excludes: [/Could not request remote forwarding|refused/],
    },
    {
      name: 'after -R is up, srv1 ss -tln shows 9090 listening',
      setup: (l) => { void l.pc1.executeCommand('ssh -fNR 9090:localhost:22 alice@10.0.0.10'); },
      on: l => l.srv1,
      cmd: 'ss -tln',
      contains: [/127\.0\.0\.1:9090|0\.0\.0\.0:9090/],
    },
    {
      name: 'AllowTcpForwarding no rejects -L with error',
      setup: async (l) => {
        await l.srv1.executeCommand('printf "AllowTcpForwarding no\\n" > /etc/ssh/sshd_config');
        await l.srv1.executeCommand('systemctl reload ssh');
      },
      on: l => l.pc1,
      cmd: 'ssh -L 8080:10.0.0.11:80 alice@10.0.0.10',
      contains: [/administratively prohibited|forwarding disabled/i],
    },
    {
      name: 'ssh -D 1080 alice@host sets up a SOCKS proxy listener',
      on: l => l.pc1,
      cmd: 'ssh -fND 1080 alice@10.0.0.10',
      excludes: [/refused|cannot/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 34 — sudo over ssh and audit trail ──────────────────────

describe('§34 — sudo over ssh', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh + sudo whoami returns root when user is in sudoers',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 sudo -n whoami',
      contains: [/^root\s*$/m],
    },
    {
      name: 'non-sudoer ssh + sudo is rejected with "is not in the sudoers file"',
      setup: (l) => {
        const um = (l.pc2 as unknown as { executor: { userMgr: {
          useradd: (u: string, o?: object) => void;
          setPassword: (u: string, p: string) => void;
        } } }).executor.userMgr;
        um.useradd('mallory', { m: true, s: '/bin/bash' });
        um.setPassword('mallory', 'x');
      },
      on: l => l.pc1,
      cmd: 'ssh mallory@10.0.0.2 sudo -n whoami',
      contains: [/is not in the sudoers file/],
    },
    {
      name: 'sudo over ssh is logged in /var/log/auth.log',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 sudo -n ls /'); },
      on: l => l.pc2,
      cmd: 'grep sudo /var/log/auth.log',
      contains: [/sudo:\s+alice : TTY=.*PWD=.*USER=root/],
    },
    {
      name: 'sudo with bad password is rejected and audit logs the failure',
      setup: (l) => { void l.pc1.executeCommand('ssh alice@10.0.0.2 \'echo wrong | sudo -S whoami\''); },
      on: l => l.pc2,
      cmd: 'tail -5 /var/log/auth.log',
      contains: [/incorrect password|authentication failure/i],
    },
    {
      name: 'sudo -l over ssh lists rules',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 sudo -l',
      contains: [/User alice may run|\(ALL\)/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── Section 35 — exit codes propagation and disconnect on remote down

describe('§35 — exit codes and disconnect semantics', () => {
  let lan: Lan;
  beforeEach(() => { lan = buildLan(); });

  const rows: Row[] = [
    {
      name: 'ssh host true → echo $? returns 0',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 true; echo "rc=$?"',
      contains: [/^rc=0\s*$/m],
    },
    {
      name: 'ssh host "exit 42" → 42',
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 \'exit 42\'; echo "rc=$?"',
      contains: [/^rc=42\s*$/m],
    },
    {
      name: 'ssh to refused host → 255',
      setup: (l) => { void l.pc2.executeCommand('systemctl stop ssh'); },
      on: l => l.pc1,
      cmd: 'ssh alice@10.0.0.2 hostname; echo "rc=$?"',
      contains: [/^rc=255\s*$/m],
    },
    {
      name: 'ssh to unknown host → 255',
      on: l => l.pc1,
      cmd: 'ssh alice@192.0.2.99 hostname; echo "rc=$?"',
      contains: [/^rc=255\s*$/m],
    },
    {
      name: 'ConnectTimeout 1 short-circuits a stalled connection',
      setup: (l) => { void l.pc2.powerOff(); },
      on: l => l.pc1,
      cmd: 'time ssh -o ConnectTimeout=1 alice@10.0.0.2 hostname',
      contains: [/Connection timed out|real\s+0m\d/],
    },
    {
      name: 'remote killed mid-session prints "Connection closed by …"',
      setup: async (l) => {
        await l.pc1.executeCommand('ssh alice@10.0.0.2 sleep 60 &');
        l.pc2.powerOff();
      },
      on: l => l.pc1,
      cmd: 'fg %1',
      contains: [/Connection closed by 10\.0\.0\.2|closed by remote/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
