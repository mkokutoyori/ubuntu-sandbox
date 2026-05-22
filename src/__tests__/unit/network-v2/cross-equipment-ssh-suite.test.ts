/**
 * Cross-equipment SSH suite — end-to-end exploratory tests.
 *
 * Sibling of `linux-lan-ssh-suite.test.ts` and `windows-lan-ssh-suite.test.ts`,
 * but exercising SSH on a **heterogeneous** LAN: Linux PCs, a Linux
 * server, Windows PCs, Cisco IOS router & switch, Huawei VRP router &
 * switch — all connected to one core switch. These tests are written
 * as an oracle of how SSH must behave end-to-end on such a network;
 * any failure pinpoints a feature gap or regression to fix.
 *
 * Topology (built fresh per test):
 *
 *     linux1 ─┐
 *     linux2 ─┤
 *     lxsrv1 ─┤
 *     win1   ─┤
 *     win2   ─┼── core-sw (GenericSwitch) ── 10.0.0.0/24
 *     ciscoR1─┤
 *     ciscoS1─┤
 *     hwR1   ─┤
 *     hwS1   ─┘
 *
 * Conventions:
 *   - linux1=10.0.0.1 linux2=10.0.0.2 lxsrv1=10.0.0.3
 *     win1=10.0.0.4   win2=10.0.0.5
 *     ciscoR1=10.0.0.6 ciscoS1=10.0.0.7
 *     hwR1=10.0.0.8    hwS1=10.0.0.9
 *   - Linux user: `alice` / `admin` (sudoer); fallback default `user` / `admin`.
 *   - Windows user: `User` / `Passw0rd!` (Administrator / `Passw0rd!`).
 *   - Cisco / Huawei VTY user: `admin` / `Admin@123`.
 *   - Every section is its own describe block. test.each drives every
 *     section so adding cases is one row of data.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── LAN fixture ────────────────────────────────────────────────────

export interface XLan {
  linux1: LinuxPC; linux2: LinuxPC; lxsrv1: LinuxServer;
  win1: WindowsPC; win2: WindowsPC;
  ciscoR1: CiscoRouter; ciscoS1: CiscoSwitch;
  hwR1: HuaweiRouter; hwS1: HuaweiSwitch;
  sw: GenericSwitch;
  ipOf: Record<string, string>;
}

async function buildXLan(): Promise<XLan> {
  EquipmentRegistry.getInstance().clear();
  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const linux2 = new LinuxPC('linux-pc', 'linux2', 0, 0);
  const lxsrv1 = new LinuxServer('linux-server', 'lxsrv1', 0, 0);
  const win1 = new WindowsPC('windows-pc', 'win1', 0, 0);
  const win2 = new WindowsPC('windows-pc', 'win2', 0, 0);
  const ciscoR1 = new CiscoRouter('cisco-router', 'ciscoR1', 0, 0);
  const ciscoS1 = new CiscoSwitch('cisco-switch', 'ciscoS1', 0, 0);
  const hwR1 = new HuaweiRouter('huawei-router', 'hwR1', 0, 0);
  const hwS1 = new HuaweiSwitch('huawei-switch', 'hwS1', 0, 0);
  const sw = new GenericSwitch('switch', 'core-sw', 0, 0);

  const all = [linux1, linux2, lxsrv1, win1, win2, ciscoR1, ciscoS1, hwR1, hwS1];
  all.forEach((d, i) => { new Cable(d.getPorts()[0], sw.getPorts()[i]); });

  const mask = new SubnetMask('255.255.255.0');
  linux1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linux2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  lxsrv1.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  win1.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  win2.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), mask);

  // Network OS interface bring-up via native CLI (no shortcut). If a
  // device does not yet honour these commands, §1 reachability fails
  // first and flags the gap before any SSH section runs.
  await ciscoR1.executeCommand('enable');
  await ciscoR1.executeCommand('configure terminal');
  await ciscoR1.executeCommand('interface GigabitEthernet0/0');
  await ciscoR1.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await ciscoR1.executeCommand('no shutdown');
  await ciscoR1.executeCommand('end');

  await ciscoS1.executeCommand('enable');
  await ciscoS1.executeCommand('configure terminal');
  await ciscoS1.executeCommand('interface vlan 1');
  await ciscoS1.executeCommand('ip address 10.0.0.7 255.255.255.0');
  await ciscoS1.executeCommand('no shutdown');
  await ciscoS1.executeCommand('end');

  await hwR1.executeCommand('system-view');
  await hwR1.executeCommand('interface GigabitEthernet0/0/0');
  await hwR1.executeCommand('ip address 10.0.0.8 255.255.255.0');
  await hwR1.executeCommand('undo shutdown');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('quit');

  await hwS1.executeCommand('system-view');
  await hwS1.executeCommand('interface Vlanif 1');
  await hwS1.executeCommand('ip address 10.0.0.9 255.255.255.0');
  await hwS1.executeCommand('undo shutdown');
  await hwS1.executeCommand('quit');
  await hwS1.executeCommand('quit');

  // Hostnames match the test labels for ssh banner / auth.log realism.
  linux1.setHostname('linux1'); linux2.setHostname('linux2'); lxsrv1.setHostname('lxsrv1');

  // Seed the standard cast of unprivileged users on every Linux node so
  // sshd accepts `alice@...`, `bob@...`, etc. Same trick as in the
  // existing Linux suite — directly via the user manager, since
  // useradd is root-only on PCs.
  for (const d of [linux1, linux2, lxsrv1]) {
    const um = (d as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      getUser: (u: string) => unknown;
      setPassword: (u: string, p: string) => void;
      usermod: (u: string, o: object) => void;
    } } }).executor.userMgr;
    for (const u of ['alice', 'bob', 'carol', 'admin']) {
      if (!um.getUser(u)) {
        um.useradd(u, { m: true, s: '/bin/bash' });
        um.setPassword(u, 'admin');
        if (u === 'alice' || u === 'admin') um.usermod(u, { aG: 'sudo' });
      }
    }
  }

  return {
    linux1, linux2, lxsrv1, win1, win2, ciscoR1, ciscoS1, hwR1, hwS1, sw,
    ipOf: {
      linux1: '10.0.0.1', linux2: '10.0.0.2', lxsrv1: '10.0.0.3',
      win1: '10.0.0.4', win2: '10.0.0.5',
      ciscoR1: '10.0.0.6', ciscoS1: '10.0.0.7',
      hwR1: '10.0.0.8', hwS1: '10.0.0.9',
    },
  };
}

// ─── Row helpers used by every section ──────────────────────────────

type AnyDev =
  | LinuxPC | LinuxServer | WindowsPC
  | CiscoRouter | CiscoSwitch | HuaweiRouter | HuaweiSwitch;

interface Row {
  /** Human-readable test label (test.each $name). */
  name: string;
  /** Optional setup steps run on the LAN before the assertion. */
  setup?: (lan: XLan) => Promise<void> | void;
  /** Device executing the command under test. */
  on: (lan: XLan) => AnyDev;
  /** The command line typed at the device prompt. */
  cmd: string;
  /** Substrings or regexes the output must contain. */
  contains?: (string | RegExp)[];
  /** Substrings or regexes the output must NOT contain. */
  excludes?: (string | RegExp)[];
}

async function runRow(lan: XLan, row: Row): Promise<string> {
  if (row.setup) await row.setup(lan);
  return (row.on(lan) as { executeCommand: (c: string) => Promise<string> }).executeCommand(row.cmd);
}

/** Enable SSH server on a Cisco IOS device with a local AAA user. */
async function enableCiscoSsh(dev: CiscoRouter | CiscoSwitch): Promise<void> {
  await dev.executeCommand('enable');
  await dev.executeCommand('configure terminal');
  await dev.executeCommand('hostname ' + (dev as { name: string }).name);
  await dev.executeCommand('username admin privilege 15 secret Admin@123');
  await dev.executeCommand('enable secret Admin@123');
  await dev.executeCommand('ip domain-name lab.local');
  await dev.executeCommand('crypto key generate rsa modulus 2048');
  await dev.executeCommand('ip ssh version 2');
  await dev.executeCommand('line vty 0 4');
  await dev.executeCommand('login local');
  await dev.executeCommand('transport input ssh');
  await dev.executeCommand('exit');
  await dev.executeCommand('end');
}

/** Enable SSH (stelnet) server on a Huawei VRP device with a local AAA user. */
async function enableHuaweiSsh(dev: HuaweiRouter | HuaweiSwitch): Promise<void> {
  await dev.executeCommand('system-view');
  await dev.executeCommand('aaa');
  await dev.executeCommand('local-user admin password cipher Admin@123');
  await dev.executeCommand('local-user admin service-type ssh');
  await dev.executeCommand('local-user admin privilege level 15');
  await dev.executeCommand('quit');
  await dev.executeCommand('rsa local-key-pair create');
  await dev.executeCommand('stelnet server enable');
  await dev.executeCommand('user-interface vty 0 4');
  await dev.executeCommand('authentication-mode aaa');
  await dev.executeCommand('protocol inbound ssh');
  await dev.executeCommand('quit');
  await dev.executeCommand('ssh user admin authentication-type password');
  await dev.executeCommand('ssh user admin service-type stelnet');
  await dev.executeCommand('quit');
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

// ─── §1 — LAN bootstrap & L3 reachability ───────────────────────────
//
// Before any SSH test makes sense, every node must own its configured
// IPv4 and answer ICMP echo from at least one peer per platform. If §1
// fails, every other section is meaningless until the fixture or the
// platform CLI is repaired.

describe('§1 — LAN bootstrap & L3 reachability', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'Linux→Linux: ping linux2 from linux1 succeeds',
      on: l => l.linux1, cmd: 'ping -c 1 -W 2 10.0.0.2',
      contains: [/1 (packets )?received|bytes from 10\.0\.0\.2/i],
      excludes: [/100% packet loss/],
    },
    {
      name: 'Linux→Server: ping lxsrv1 from linux1 succeeds',
      on: l => l.linux1, cmd: 'ping -c 1 -W 2 10.0.0.3',
      contains: [/bytes from 10\.0\.0\.3|1 (packets )?received/i],
    },
    {
      name: 'Linux→Windows: ping win1 from linux1 succeeds',
      on: l => l.linux1, cmd: 'ping -c 1 -W 2 10.0.0.4',
      contains: [/bytes from 10\.0\.0\.4|1 (packets )?received/i],
    },
    {
      name: 'Linux→Cisco router: ping ciscoR1 from linux1 succeeds',
      on: l => l.linux1, cmd: 'ping -c 1 -W 2 10.0.0.6',
      contains: [/bytes from 10\.0\.0\.6|1 (packets )?received/i],
    },
    {
      name: 'Linux→Huawei router: ping hwR1 from linux1 succeeds',
      on: l => l.linux1, cmd: 'ping -c 1 -W 2 10.0.0.8',
      contains: [/bytes from 10\.0\.0\.8|1 (packets )?received/i],
    },
    {
      name: 'Windows→Linux: ping linux1 from win1 succeeds',
      on: l => l.win1, cmd: 'ping 10.0.0.1',
      contains: [/Reply from 10\.0\.0\.1|bytes=/i],
    },
    {
      name: 'Windows→Cisco: ping ciscoR1 from win2 succeeds',
      on: l => l.win2, cmd: 'ping 10.0.0.6',
      contains: [/Reply from 10\.0\.0\.6|bytes=/i],
    },
    {
      name: 'Cisco→Linux: ping linux1 from ciscoR1 succeeds',
      setup: (l) => { void l.ciscoR1.executeCommand('enable'); },
      on: l => l.ciscoR1, cmd: 'ping 10.0.0.1',
      contains: [/!!!!!|Success rate is [1-9]/],
    },
    {
      name: 'Huawei→Linux: ping linux1 from hwR1 succeeds',
      on: l => l.hwR1, cmd: 'ping 10.0.0.1',
      contains: [/bytes from 10\.0\.0\.1|Reply from 10\.0\.0\.1/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §2 — Linux → Linux SSH happy path ──────────────────────────────
//
// A Linux operator drives `ssh` exactly as a real user would; the
// client traffic must traverse core-sw to reach sshd on the peer.

describe('§2 — Linux → Linux SSH happy path', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'PC→PC: ssh alice@linux2 greets and closes cleanly',
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu', /Connection to 10\.0\.0\.2 closed/],
      excludes: [/refused/, /Permission denied/],
    },
    {
      name: 'PC→Server: ssh alice@lxsrv1 reaches the server',
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.3',
      contains: ['Welcome to Ubuntu'],
      excludes: [/refused/],
    },
    {
      name: 'Server→PC: lxsrv1 reaches linux2 for admin',
      on: l => l.lxsrv1, cmd: 'ssh alice@10.0.0.2',
      contains: ['Welcome to Ubuntu'],
    },
    {
      name: 'one-shot remote command returns remote stdout',
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2 whoami',
      contains: [/^alice$/m],
      excludes: [/Permission denied/],
    },
    {
      name: 'remote hostname matches the target device',
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2 hostname',
      contains: [/^linux2$/m],
    },
    {
      name: 'when the user is omitted the local user is used',
      on: l => l.linux1, cmd: 'ssh 10.0.0.2',
      contains: ['Welcome to Ubuntu'],
      excludes: [/Permission denied/],
    },
    {
      name: 'ssh -l alice host is equivalent to alice@host',
      on: l => l.linux1, cmd: 'ssh -l alice 10.0.0.2 hostname',
      contains: [/^linux2$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §3 — Linux → Windows SSH ───────────────────────────────────────
//
// A Linux operator manages Windows hosts via OpenSSH for Windows. The
// remote shell may be cmd.exe (default) or PowerShell — both must be
// reachable through the SSH channel without leaking to bash.

describe('§3 — Linux → Windows SSH', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'ssh User@win1 hostname returns the Windows machine name',
      on: l => l.linux1, cmd: 'ssh User@10.0.0.4 hostname',
      contains: [/^win1$/m],
    },
    {
      name: 'ver shows the Microsoft Windows version banner',
      on: l => l.linux1, cmd: 'ssh User@10.0.0.4 ver',
      contains: [/Microsoft Windows|Version/i],
    },
    {
      name: 'PowerShell can be invoked as remote shell',
      on: l => l.linux1,
      cmd: 'ssh User@10.0.0.4 powershell -Command "Get-Host | Select-Object -ExpandProperty Name"',
      contains: [/ConsoleHost|PowerShell/i],
    },
    {
      name: 'whoami over SSH includes the Windows User form',
      on: l => l.linux1, cmd: 'ssh User@10.0.0.4 whoami',
      contains: [/User/],
    },
    {
      name: 'wrong Windows password is rejected by sshd',
      on: l => l.linux1, cmd: 'sshpass -p Wrong! ssh User@10.0.0.4 hostname',
      contains: [/Permission denied|Authentication failed/i],
      excludes: [/^win1$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §4 — Windows → Linux SSH ───────────────────────────────────────
//
// Symmetric counterpart of §3: ssh.exe driven from cmd.exe or
// PowerShell on a Windows host, targeting a Linux peer. Same transport
// must be spoken from both sides.

describe('§4 — Windows → Linux SSH', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'ssh alice@linux1 returns linux1 as hostname',
      on: l => l.win1, cmd: 'ssh alice@10.0.0.1 hostname',
      contains: [/^linux1$/m],
    },
    {
      name: 'uname -a from Windows reflects the Linux kernel banner',
      on: l => l.win1, cmd: 'ssh alice@10.0.0.1 uname -a',
      contains: [/Linux/],
    },
    {
      name: 'remote whoami returns the Linux user, not the Windows User',
      on: l => l.win1, cmd: 'ssh alice@10.0.0.1 whoami',
      contains: [/^alice$/m], excludes: [/^User$/m],
    },
    {
      name: 'PowerShell pipeline captures remote stdout into a variable',
      on: l => l.win1,
      cmd: 'powershell -Command "$h = ssh alice@10.0.0.1 hostname; $h"',
      contains: ['linux1'],
    },
    {
      name: 'ssh client surfaces connection refused when sshd is stopped',
      setup: async (l) => {
        await l.linux1.executeCommand('sudo systemctl stop ssh');
      },
      on: l => l.win1, cmd: 'ssh -o ConnectTimeout=2 alice@10.0.0.1 whoami',
      contains: [/Connection refused|Could not connect/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §5 — Linux → Cisco IOS SSH ─────────────────────────────────────
//
// The remote channel is bound to CiscoIOSShell, not to bash. Login
// authenticates against the local-user database, the prompt belongs
// to user-exec, and `transport input none` rejects SSH at the VTY.

describe('§5 — Linux → Cisco IOS SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableCiscoSsh(lan.ciscoS1);
  });

  const rows: Row[] = [
    {
      name: 'show version on the Cisco router prints the IOS banner',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i], excludes: [/bash:|command not found/i],
    },
    {
      name: 'show interfaces status on the Cisco switch lists ports',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.7 "show interfaces status"',
      contains: [/connected|notconnect|Port\s+Name/i],
    },
    {
      name: 'remote prompt is the IOS hostname, never bash',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.6 "show running-config | include hostname"',
      contains: [/hostname ciscoR1/i], excludes: [/GNU bash|sh-\d/],
    },
    {
      name: 'transport input none refuses SSH at the VTY',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('line vty 0 4');
        await l.ciscoR1.executeCommand('transport input none');
        await l.ciscoR1.executeCommand('end');
      },
      on: l => l.linux1,
      cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.6 "show version"',
      contains: [/Connection (closed|refused)|denied/i],
    },
    {
      name: 'wrong VTY password is rejected',
      on: l => l.linux1, cmd: 'sshpass -p Wrong! ssh admin@10.0.0.6 "show version"',
      contains: [/Permission denied|Authentication failed/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §6 — Linux → Huawei VRP SSH ────────────────────────────────────
//
// stelnet server binds the channel to HuaweiVRPShell. Authentication
// uses an AAA local-user with `service-type ssh`. `undo stelnet server
// enable` must refuse the connection.

describe('§6 — Linux → Huawei VRP SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableHuaweiSsh(lan.hwR1);
    await enableHuaweiSsh(lan.hwS1);
  });

  const rows: Row[] = [
    {
      name: 'display version on the Huawei router prints the VRP banner',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.8 "display version"',
      contains: [/VRP|Huawei/i], excludes: [/bash:|command not found/i],
    },
    {
      name: 'display interface brief on the Huawei switch lists Vlanif1',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.9 "display interface brief"',
      contains: [/Interface\s+PHY|Vlanif1/i],
    },
    {
      name: 'display current-configuration shows stelnet server enabled',
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.8 "display current-configuration"',
      contains: [/stelnet server enable/, /protocol inbound ssh/],
    },
    {
      name: 'undo stelnet server enable refuses SSH',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('undo stelnet server enable');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1,
      cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.8 "display version"',
      contains: [/Connection (closed|refused)/i],
    },
    {
      name: 'protocol inbound telnet alone refuses SSH at the VTY',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('user-interface vty 0 4');
        await l.hwR1.executeCommand('protocol inbound telnet');
        await l.hwR1.executeCommand('quit');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1,
      cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.8 "display version"',
      contains: [/Connection (closed|refused)|denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §7 — Windows → Cisco / Huawei SSH ──────────────────────────────
//
// The Windows OpenSSH client must speak the same transport as Linux
// and bind to the platform-native CLI on the remote side (IOS / VRP),
// never to cmd.exe or bash.

describe('§7 — Windows → Cisco / Huawei SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Windows ssh.exe reaches IOS and runs show version',
      on: l => l.win1, cmd: 'ssh admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i], excludes: [/Microsoft Windows|cmd\.exe/i],
    },
    {
      name: 'Windows ssh.exe reaches VRP and runs display version',
      on: l => l.win1, cmd: 'ssh admin@10.0.0.8 "display version"',
      contains: [/VRP|Huawei/i], excludes: [/Microsoft Windows|cmd\.exe/i],
    },
    {
      name: 'remote prompt on IOS is context-sensitive help, not cmd.exe',
      on: l => l.win1, cmd: 'ssh admin@10.0.0.6 "?"',
      excludes: [/Microsoft Windows|cmd\.exe|GNU bash/i],
    },
    {
      name: 'PowerShell pipeline can pipe show output through Select-String',
      on: l => l.win1,
      cmd: 'powershell -Command "ssh admin@10.0.0.6 show version | Select-String IOS"',
      contains: [/IOS/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §8 — Cisco / Huawei → Linux & Windows SSH (outbound) ───────────
//
// Network OSes must include an SSH client in privileged exec / system
// view that traverses the LAN to reach Linux and Windows hosts.

describe('§8 — Cisco / Huawei → Linux & Windows SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'IOS: ssh -l alice 10.0.0.1 reaches a Linux PC',
      setup: (l) => { void l.ciscoR1.executeCommand('enable'); },
      on: l => l.ciscoR1, cmd: 'ssh -l alice 10.0.0.1',
      contains: [/Welcome to Ubuntu/i],
      excludes: [/Invalid input|Unknown command/i],
    },
    {
      name: 'IOS: ssh -l User 10.0.0.4 reaches a Windows PC',
      setup: (l) => { void l.ciscoR1.executeCommand('enable'); },
      on: l => l.ciscoR1, cmd: 'ssh -l User 10.0.0.4',
      contains: [/Microsoft Windows|win1/i],
    },
    {
      name: 'IOS: ssh -l admin 10.0.0.8 reaches the Huawei router',
      setup: (l) => { void l.ciscoR1.executeCommand('enable'); },
      on: l => l.ciscoR1, cmd: 'ssh -l admin 10.0.0.8',
      contains: [/VRP|Huawei|<hwR1>/i],
    },
    {
      name: 'VRP: stelnet 10.0.0.1 reaches a Linux PC',
      on: l => l.hwR1, cmd: 'stelnet 10.0.0.1',
      contains: [/Welcome to Ubuntu/i],
      excludes: [/Unrecognized|Error: Unrecognized/i],
    },
    {
      name: 'VRP: stelnet 10.0.0.6 reaches the Cisco router',
      on: l => l.hwR1, cmd: 'stelnet 10.0.0.6',
      contains: [/IOS|Cisco|ciscoR1/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §9 — Command flow: alias must drive the same handler as the canonical command ──
//
// Core grievance: today `sudo` triggers behaviour by *name match*. After
// `alias sudo=please`, typing `please …` should follow the exact same
// privilege-escalation flow, not a no-op or a recursive lookup. Same on
// Windows (Set-Alias), Cisco (alias exec), Huawei (command-privilege /
// alias). This section is the design oracle: aliasing must rebind the
// command name to the same flow descriptor, never duplicate behaviour
// by string-matching the typed token.

describe('§9 — Command flow respects aliases on every shell', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'bash: alias sudo=please then please whoami runs as root',
      setup: async (l) => {
        await l.linux1.executeCommand('su - alice');
        await l.linux1.executeCommand("alias sudo='please'");
        await l.linux1.executeCommand("alias please='sudo'");
      },
      on: l => l.linux1, cmd: 'please whoami',
      contains: [/^root$/m],
      excludes: [/command not found|please: not found/i],
    },
    {
      name: 'bash: alias ll="ls -la" routes through the ls handler',
      setup: (l) => { void l.linux1.executeCommand("alias ll='ls -la'"); },
      on: l => l.linux1, cmd: 'll /etc',
      contains: [/passwd/, /hosts/],
    },
    {
      name: 'bash: shell function shadows the same name as a builtin',
      setup: (l) => {
        void l.linux1.executeCommand("function cd { echo CUSTOM:$1; }");
      },
      on: l => l.linux1, cmd: 'cd /tmp',
      contains: [/^CUSTOM:\/tmp$/m],
    },
    {
      name: 'PowerShell: Set-Alias sudo Invoke-Elevated runs the elevation flow',
      setup: async (l) => {
        await l.win1.executeCommand(
          'powershell -Command "function Invoke-Elevated { whoami }; Set-Alias sudo Invoke-Elevated"',
        );
      },
      on: l => l.win1,
      cmd: 'powershell -Command "Invoke-Elevated"',
      contains: [/User/],
    },
    {
      name: 'cmd.exe: doskey macro routes to the same dir handler',
      setup: async (l) => { await l.win1.executeCommand('doskey ll=dir /a $*'); },
      on: l => l.win1, cmd: 'll',
      contains: [/Directory of/i],
    },
    {
      name: 'IOS: alias exec sr "show running-config" runs the show handler',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('enable');
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('alias exec sr show running-config');
        await l.ciscoR1.executeCommand('end');
      },
      on: l => l.ciscoR1, cmd: 'sr | include hostname',
      contains: [/hostname ciscoR1/i],
    },
    {
      name: 'VRP: command-privilege alias dis-cur for display current-configuration',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('command-alias enable');
        await l.hwR1.executeCommand('command-alias alias dis-cur display current-configuration');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.hwR1, cmd: 'dis-cur',
      contains: [/interface GigabitEthernet0\/0\/0/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §10 — Authentication methods across the LAN ────────────────────
//
// password, publickey and keyboard-interactive must all be reachable
// on every SSH server type. ssh -o PreferredAuthentications= drives
// the negotiation explicitly.

describe('§10 — SSH authentication methods', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux→Linux: password auth works for alice',
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=password alice@10.0.0.2 whoami',
      contains: [/^alice$/m],
    },
    {
      name: 'Linux→Linux: publickey auth after ssh-keygen+ssh-copy-id works',
      setup: async (l) => {
        await l.linux1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
        await l.linux1.executeCommand('ssh-copy-id alice@10.0.0.2');
      },
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
      contains: [/^alice$/m],
      excludes: [/Permission denied/i],
    },
    {
      name: 'Linux→Linux: publickey fails without prior key install',
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no alice@10.0.0.2 whoami',
      contains: [/Permission denied/i],
      excludes: [/^alice$/m],
    },
    {
      name: 'Linux→Windows: password auth works for User',
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=password User@10.0.0.4 hostname',
      contains: [/^win1$/m],
    },
    {
      name: 'Linux→Cisco: password auth against local-user database',
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=password admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i],
    },
    {
      name: 'Linux→Huawei: password auth against AAA local-user',
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=password admin@10.0.0.8 "display version"',
      contains: [/VRP|Huawei/i],
    },
    {
      name: 'Linux→Huawei: publickey after ssh user admin assign rsa-key',
      setup: async (l) => {
        await l.linux1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
        const pub = await l.linux1.executeCommand('cat /root/.ssh/id_rsa.pub');
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand(`rsa peer-public-key linux1key encoding-type openssh`);
        await l.hwR1.executeCommand(`public-key-code begin`);
        await l.hwR1.executeCommand(pub.trim().split(' ')[1]);
        await l.hwR1.executeCommand(`public-key-code end`);
        await l.hwR1.executeCommand(`peer-public-key end`);
        await l.hwR1.executeCommand('ssh user admin authentication-type rsa');
        await l.hwR1.executeCommand('ssh user admin assign rsa-key linux1key');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1,
      cmd: 'ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no admin@10.0.0.8 "display version"',
      contains: [/VRP|Huawei/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §11 — Host key TOFU & known_hosts coherence ────────────────────
//
// First connection to any peer must register its host key in
// ~/.ssh/known_hosts (TOFU). A mismatched key on a subsequent connect
// must be rejected loudly with the standard "REMOTE HOST IDENTIFICATION
// HAS CHANGED" banner — on every client platform.

describe('§11 — known_hosts coherence across platforms', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux: first connect with accept-new persists host key',
      setup: async (l) => {
        await l.linux1.executeCommand('rm -f /root/.ssh/known_hosts');
        await l.linux1.executeCommand('ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 hostname');
      },
      on: l => l.linux1, cmd: 'cat /root/.ssh/known_hosts',
      contains: [/10\.0\.0\.2/, /ssh-(rsa|ed25519|ecdsa)/i],
    },
    {
      name: 'Linux: second connect uses stored host key (no prompt)',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 hostname');
      },
      on: l => l.linux1,
      cmd: 'ssh -o StrictHostKeyChecking=yes alice@10.0.0.2 hostname',
      contains: [/^linux2$/m], excludes: [/authenticity of host/i, /yes\/no/i],
    },
    {
      name: 'Linux: regenerated remote host key triggers identification-changed',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.2 hostname');
        await l.linux2.executeCommand('sudo ssh-keygen -A -f /etc/ssh -t rsa');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
      },
      on: l => l.linux1,
      cmd: 'ssh -o StrictHostKeyChecking=yes alice@10.0.0.2 hostname',
      contains: [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i],
      excludes: [/^linux2$/m],
    },
    {
      name: 'Windows: ssh.exe stores host key in %USERPROFILE%\\.ssh\\known_hosts',
      setup: async (l) => {
        await l.win1.executeCommand('ssh -o StrictHostKeyChecking=accept-new alice@10.0.0.1 hostname');
      },
      on: l => l.win1, cmd: 'type %USERPROFILE%\\.ssh\\known_hosts',
      contains: [/10\.0\.0\.1/],
    },
    {
      name: 'Cisco: ip ssh known-hosts records server keys for outbound ssh',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('enable');
        await l.ciscoR1.executeCommand('ssh -l alice 10.0.0.1');
      },
      on: l => l.ciscoR1, cmd: 'show ip ssh known-hosts',
      contains: [/10\.0\.0\.1/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §12 — ~/.ssh/config Host blocks ────────────────────────────────
//
// Per-host options (User, Port, IdentityFile, ProxyJump, StrictHost…)
// must be honoured by the client so operators stop typing flags.

describe('§12 — ~/.ssh/config Host blocks', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const writeConfig = async (l: XLan, body: string) => {
    await l.linux1.executeCommand('mkdir -p /root/.ssh');
    await l.linux1.executeCommand(`cat > /root/.ssh/config <<'EOF'\n${body}\nEOF`);
    await l.linux1.executeCommand('chmod 600 /root/.ssh/config');
  };

  const rows: Row[] = [
    {
      name: 'Host alias resolves HostName and User',
      setup: async (l) => {
        await writeConfig(l, 'Host two\n  HostName 10.0.0.2\n  User alice');
      },
      on: l => l.linux1, cmd: 'ssh two hostname',
      contains: [/^linux2$/m],
    },
    {
      name: 'Wildcard Host * applies User and StrictHostKeyChecking',
      setup: async (l) => {
        await writeConfig(l, 'Host *\n  User alice\n  StrictHostKeyChecking accept-new');
      },
      on: l => l.linux1, cmd: 'ssh 10.0.0.2 whoami',
      contains: [/^alice$/m],
    },
    {
      name: 'Per-host Port override is honoured',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sed -i "s/^#\\?Port .*/Port 2222/" /etc/ssh/sshd_config');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
        await writeConfig(l, 'Host two\n  HostName 10.0.0.2\n  User alice\n  Port 2222');
      },
      on: l => l.linux1, cmd: 'ssh two hostname',
      contains: [/^linux2$/m],
    },
    {
      name: 'IdentityFile is read for the matching Host only',
      setup: async (l) => {
        await l.linux1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_two");
        await l.linux1.executeCommand('ssh-copy-id -i /root/.ssh/id_two.pub alice@10.0.0.2');
        await writeConfig(l, 'Host two\n  HostName 10.0.0.2\n  User alice\n  IdentityFile /root/.ssh/id_two\n  IdentitiesOnly yes');
      },
      on: l => l.linux1,
      cmd: 'ssh -o PasswordAuthentication=no two whoami',
      contains: [/^alice$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §13 — ProxyJump across heterogeneous hops ──────────────────────
//
// ssh -J jumpbox target must traverse the real network: TCP from
// client → jumpbox, then nested TCP from jumpbox → target, then the
// SSH transport piggy-backs on that pipe. Works with mixed platforms.

describe('§13 — ProxyJump across heterogeneous hops', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux→Linux→Linux: ssh -J linux2 lxsrv1',
      on: l => l.linux1,
      cmd: 'ssh -J alice@10.0.0.2 alice@10.0.0.3 hostname',
      contains: [/^lxsrv1$/m],
      excludes: [/refused|denied/i],
    },
    {
      name: 'Linux→Linux→Windows: ssh -J linux2 win1',
      on: l => l.linux1,
      cmd: 'ssh -J alice@10.0.0.2 User@10.0.0.4 hostname',
      contains: [/^win1$/m],
    },
    {
      name: 'Linux→Linux→Cisco: ssh -J linux2 ciscoR1',
      on: l => l.linux1,
      cmd: 'ssh -J alice@10.0.0.2 admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i],
    },
    {
      name: 'two-hop ProxyJump: linux1 → linux2 → lxsrv1 → ciscoR1',
      on: l => l.linux1,
      cmd: 'ssh -J alice@10.0.0.2,alice@10.0.0.3 admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i],
    },
    {
      name: 'ProxyJump uses ~/.ssh/config Host alias',
      setup: async (l) => {
        await l.linux1.executeCommand('mkdir -p /root/.ssh');
        await l.linux1.executeCommand("cat > /root/.ssh/config <<'EOF'\nHost jump\n  HostName 10.0.0.2\n  User alice\nHost target\n  HostName 10.0.0.3\n  User alice\n  ProxyJump jump\nEOF");
      },
      on: l => l.linux1, cmd: 'ssh target hostname',
      contains: [/^lxsrv1$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §14 — Local / Remote / Dynamic port forwarding ─────────────────
//
// ssh -L / -R / -D must open real TCP listeners on the side that owns
// the forwarding direction, forward bytes through the SSH channel and
// drop them onto a real TCP socket on the other side. Tested with the
// in-memory http server on each Linux peer.

describe('§14 — SSH port forwarding (-L / -R / -D)', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await lan.lxsrv1.executeCommand('python3 -m http.server 8080 --bind 127.0.0.1 &');
  });

  const rows: Row[] = [
    {
      name: '-L 9000:127.0.0.1:8080 forwards localhost:9000 to lxsrv1:8080',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh -f -N -L 9000:127.0.0.1:8080 alice@10.0.0.3');
      },
      on: l => l.linux1, cmd: 'curl -s http://127.0.0.1:9000/',
      contains: [/<html|Directory listing|<title/i],
    },
    {
      name: '-R 9100:127.0.0.1:80 forwards a port back to the client',
      setup: async (l) => {
        await l.linux1.executeCommand('python3 -m http.server 80 --bind 127.0.0.1 &');
        await l.linux1.executeCommand('ssh -f -N -R 9100:127.0.0.1:80 alice@10.0.0.3');
      },
      on: l => l.lxsrv1, cmd: 'curl -s http://127.0.0.1:9100/',
      contains: [/<html|Directory listing|<title/i],
    },
    {
      name: '-D 1080 opens a SOCKS proxy that reaches remote hosts',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh -f -N -D 1080 alice@10.0.0.2');
      },
      on: l => l.linux1,
      cmd: 'curl -s --socks5 127.0.0.1:1080 http://10.0.0.3:8080/',
      contains: [/<html|Directory listing|<title/i],
    },
    {
      name: 'GatewayPorts no: -L bind is local-only (refused from a peer)',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh -f -N -L 9000:127.0.0.1:8080 alice@10.0.0.3');
      },
      on: l => l.linux2,
      cmd: 'curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 http://10.0.0.1:9000/',
      contains: [/^000$|Connection refused/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §15 — SCP / SFTP cross-platform file transfer ──────────────────
//
// File transfers must traverse the same SSH channel and land in the
// remote VFS with correct ownership, mode and content. Both directions
// (push & pull), all three platform pairs (Linux/Linux, Linux/Windows,
// Linux/Cisco-running-config).

describe('§15 — SCP / SFTP cross-platform transfer', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
  });

  const rows: Row[] = [
    {
      name: 'scp file from linux1 to linux2 lands with the same content',
      setup: async (l) => {
        await l.linux1.executeCommand('echo "hello from linux1" > /tmp/payload.txt');
        await l.linux1.executeCommand('scp /tmp/payload.txt alice@10.0.0.2:/tmp/payload.txt');
      },
      on: l => l.linux2, cmd: 'cat /tmp/payload.txt',
      contains: [/^hello from linux1$/m],
    },
    {
      name: 'scp -p preserves mtime and mode',
      setup: async (l) => {
        await l.linux1.executeCommand('echo data > /tmp/keep.txt && chmod 640 /tmp/keep.txt');
        await l.linux1.executeCommand('scp -p /tmp/keep.txt alice@10.0.0.2:/tmp/keep.txt');
      },
      on: l => l.linux2, cmd: 'stat -c "%a" /tmp/keep.txt',
      contains: [/^640$/m],
    },
    {
      name: 'scp pull from win1 onto linux1 reads cmd.exe-style path',
      setup: async (l) => {
        await l.win1.executeCommand('echo win-payload > C:\\Users\\User\\payload.txt');
        await l.linux1.executeCommand('scp User@10.0.0.4:/C:/Users/User/payload.txt /tmp/win-payload.txt');
      },
      on: l => l.linux1, cmd: 'cat /tmp/win-payload.txt',
      contains: [/^win-payload$/m],
    },
    {
      name: 'sftp put then get round-trips the file unchanged',
      setup: async (l) => {
        await l.linux1.executeCommand('echo roundtrip > /tmp/rt.txt');
        await l.linux1.executeCommand(
          "sftp alice@10.0.0.2 <<'EOF'\nput /tmp/rt.txt /tmp/rt.txt\nbye\nEOF",
        );
        await l.linux1.executeCommand('rm /tmp/rt.txt');
        await l.linux1.executeCommand(
          "sftp alice@10.0.0.2 <<'EOF'\nget /tmp/rt.txt /tmp/rt.txt\nbye\nEOF",
        );
      },
      on: l => l.linux1, cmd: 'cat /tmp/rt.txt',
      contains: [/^roundtrip$/m],
    },
    {
      name: 'copy running-config tftp via SSH (Cisco scp server)',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('ip scp server enable');
        await l.ciscoR1.executeCommand('end');
        await l.linux1.executeCommand('scp admin@10.0.0.6:running-config /tmp/running.txt');
      },
      on: l => l.linux1, cmd: 'grep hostname /tmp/running.txt',
      contains: [/hostname ciscoR1/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §16 — SSH agent & agent forwarding ─────────────────────────────
//
// ssh-agent must store unlocked keys; -A must forward the agent socket
// so a hop can authenticate further with the same identity. Works
// across Linux→Linux→Cisco/Huawei.

describe('§16 — SSH agent & agent forwarding', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await lan.linux1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    await lan.linux1.executeCommand('ssh-copy-id alice@10.0.0.2');
    await lan.linux1.executeCommand('ssh-copy-id alice@10.0.0.3');
    await lan.linux1.executeCommand('eval $(ssh-agent -s) && ssh-add /root/.ssh/id_rsa');
  });

  const rows: Row[] = [
    {
      name: 'ssh-add -l lists the loaded key',
      on: l => l.linux1, cmd: 'ssh-add -l',
      contains: [/2048 SHA256:|RSA|\/root\/\.ssh\/id_rsa/i],
    },
    {
      name: 'agent-backed connection works without a password prompt',
      on: l => l.linux1,
      cmd: 'ssh -o PasswordAuthentication=no alice@10.0.0.2 whoami',
      contains: [/^alice$/m],
    },
    {
      name: '-A: agent forwarded to first hop authenticates the next hop',
      on: l => l.linux1,
      cmd: 'ssh -A alice@10.0.0.2 "ssh -o PasswordAuthentication=no alice@10.0.0.3 hostname"',
      contains: [/^lxsrv1$/m],
    },
    {
      name: 'no -A: agent NOT forwarded — second hop fails publickey',
      on: l => l.linux1,
      cmd: 'ssh alice@10.0.0.2 "ssh -o PasswordAuthentication=no alice@10.0.0.3 hostname"',
      contains: [/Permission denied/i], excludes: [/^lxsrv1$/m],
    },
    {
      name: 'SSH_AUTH_SOCK is exported into the remote shell when -A is used',
      on: l => l.linux1,
      cmd: 'ssh -A alice@10.0.0.2 \'echo $SSH_AUTH_SOCK\'',
      contains: [/\/tmp\/ssh-/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §17 — Banner, MOTD, last-login per platform ────────────────────
//
// Pre-auth banner (/etc/issue.net on Linux, banner motd on Cisco/Huawei,
// LegalNoticeText on Windows) must reach the client before the password
// prompt. /etc/motd and last-login show post-auth.

describe('§17 — Banner, MOTD and last-login per platform', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux: /etc/issue.net is displayed pre-auth',
      setup: (l) => { void l.linux2.executeCommand("echo 'AUTHORIZED USE ONLY' > /etc/issue.net"); },
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2',
      contains: ['AUTHORIZED USE ONLY'],
    },
    {
      name: 'Linux: /etc/motd is shown after auth',
      setup: (l) => { void l.linux2.executeCommand("echo 'Property of ACME' > /etc/motd"); },
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2',
      contains: ['Property of ACME'],
    },
    {
      name: 'Linux: last login line appears on subsequent connect',
      setup: async (l) => {
        await l.linux1.executeCommand('ssh alice@10.0.0.2 exit');
      },
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2',
      contains: [/Last login:.* from 10\.0\.0\.1/i],
    },
    {
      name: 'Cisco: banner motd is shown to SSH clients',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('banner motd # AUTHORIZED USE ONLY #');
        await l.ciscoR1.executeCommand('end');
      },
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.6',
      contains: ['AUTHORIZED USE ONLY'],
    },
    {
      name: 'Huawei: header login information is shown to SSH clients',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('header login information "VRP AUTH NOTICE"');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.8',
      contains: ['VRP AUTH NOTICE'],
    },
    {
      name: 'Windows: LegalNoticeText reaches the SSH client',
      setup: async (l) => {
        await l.win1.executeCommand('reg add "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v LegalNoticeText /d "WIN BANNER" /f');
      },
      on: l => l.linux1, cmd: 'ssh User@10.0.0.4',
      contains: ['WIN BANNER'],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §18 — Brute-force protection / rate-limit ──────────────────────
//
// MaxAuthTries on Linux, login block-for on Cisco, ssh server-source
// max-attempts on Huawei, Account Lockout Policy on Windows — every
// platform must throttle bursts of wrong passwords coming from the
// same client IP.

describe('§18 — Brute-force protection on every SSH server', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux: MaxAuthTries=3 closes the connection on the 4th wrong attempt',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sed -i "s/^#\\?MaxAuthTries.*/MaxAuthTries 3/" /etc/ssh/sshd_config');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
      },
      on: l => l.linux1,
      cmd: 'for i in 1 2 3 4; do sshpass -p WRONG ssh -o NumberOfPasswordPrompts=1 alice@10.0.0.2 hostname; done',
      contains: [/Too many authentication failures|Connection closed/i],
    },
    {
      name: 'Cisco: login block-for blocks subsequent connect attempts',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('login block-for 60 attempts 2 within 30');
        await l.ciscoR1.executeCommand('end');
        for (const _ of [1, 2, 3]) {
          await l.linux1.executeCommand('sshpass -p WRONG ssh -o NumberOfPasswordPrompts=1 admin@10.0.0.6 "show version"');
        }
      },
      on: l => l.linux1,
      cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.6 "show version"',
      contains: [/Connection (closed|refused)|Quiet-Mode|denied/i],
    },
    {
      name: 'Huawei: ssh server authentication-retries limits attempts',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('ssh server authentication-retries 2');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1,
      cmd: 'for i in 1 2 3; do sshpass -p WRONG ssh -o NumberOfPasswordPrompts=1 admin@10.0.0.8 "display version"; done',
      contains: [/Too many|Authentication failed|disconnected/i],
    },
    {
      name: 'Windows: Account Lockout Threshold disables the account',
      setup: async (l) => {
        await l.win1.executeCommand('net accounts /lockoutthreshold:3');
        for (const _ of [1, 2, 3]) {
          await l.linux1.executeCommand('sshpass -p WRONG ssh -o NumberOfPasswordPrompts=1 User@10.0.0.4 hostname');
        }
      },
      on: l => l.linux1,
      cmd: 'sshpass -p Passw0rd! ssh -o NumberOfPasswordPrompts=1 User@10.0.0.4 hostname',
      contains: [/locked out|Account is currently locked|Permission denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §19 — PTY allocation, signals & window size ────────────────────
//
// ssh -t / -tt forces a PTY; resize must propagate via SIGWINCH; ^C in
// the client must deliver SIGINT to the remote process group; exit
// codes from the remote signal must be 128+N as POSIX prescribes.

describe('§19 — PTY allocation, signals and window size', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
  });

  const rows: Row[] = [
    {
      name: 'ssh -t alice@linux2 tty reports a /dev/pts entry',
      on: l => l.linux1, cmd: 'ssh -t alice@10.0.0.2 tty',
      contains: [/\/dev\/pts\/\d+/],
    },
    {
      name: 'ssh without -t closes stdin and tty reports not a tty',
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2 tty',
      contains: [/not a tty/i],
    },
    {
      name: 'COLUMNS and LINES reach the remote shell from the client TTY',
      on: l => l.linux1,
      cmd: 'stty cols 132 rows 50; ssh -t alice@10.0.0.2 \'echo $COLUMNS:$LINES\'',
      contains: [/^132:50$/m],
    },
    {
      name: 'Ctrl-C on the client kills the remote process group',
      on: l => l.linux1,
      cmd: 'timeout 1 ssh -t alice@10.0.0.2 "trap \'echo caught; exit 130\' INT; sleep 5"',
      contains: [/caught|^130$/m],
    },
    {
      name: 'remote exit 130 (SIGINT) is surfaced through the client',
      on: l => l.linux1,
      cmd: 'ssh alice@10.0.0.2 "bash -c \'kill -INT $$\'"; echo rc=$?',
      contains: [/rc=130/],
    },
    {
      name: 'Cisco IOS: ssh client uses a line-mode pty for the VTY',
      setup: (l) => { void l.ciscoR1.executeCommand('enable'); },
      on: l => l.ciscoR1, cmd: 'ssh -l alice 10.0.0.1 tty',
      contains: [/\/dev\/pts\/\d+/],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §20 — Environment forwarding & sshd AcceptEnv ──────────────────
//
// ssh -o SendEnv=… + sshd AcceptEnv must propagate the named variables
// from the client environment into the remote shell. PermitUserEnvironment
// allows ~/.ssh/environment overrides.

describe('§20 — Environment forwarding', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const rows: Row[] = [
    {
      name: 'LC_GREETING is forwarded when AcceptEnv allows it',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sh -c "echo AcceptEnv LC_GREETING >> /etc/ssh/sshd_config"');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
      },
      on: l => l.linux1,
      cmd: 'LC_GREETING=hello ssh -o SendEnv=LC_GREETING alice@10.0.0.2 \'echo $LC_GREETING\'',
      contains: [/^hello$/m],
    },
    {
      name: 'unlisted variable is NOT forwarded',
      on: l => l.linux1,
      cmd: 'MY_SECRET=oops ssh -o SendEnv=MY_SECRET alice@10.0.0.2 \'echo ${MY_SECRET:-empty}\'',
      contains: [/^empty$/m],
    },
    {
      name: 'PermitUserEnvironment yes lets ~/.ssh/environment seed the shell',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sed -i "s/^#\\?PermitUserEnvironment.*/PermitUserEnvironment yes/" /etc/ssh/sshd_config');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
        await l.linux2.executeCommand('mkdir -p /home/alice/.ssh && echo MOOD=happy > /home/alice/.ssh/environment && chown -R alice:alice /home/alice/.ssh');
      },
      on: l => l.linux1,
      cmd: 'ssh alice@10.0.0.2 \'echo $MOOD\'',
      contains: [/^happy$/m],
    },
    {
      name: 'TERM is propagated from the client TTY to the remote shell',
      on: l => l.linux1,
      cmd: 'TERM=xterm-256color ssh -t alice@10.0.0.2 \'echo $TERM\'',
      contains: [/^xterm-256color$/m],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});

// ─── §21 — sshd access control (allow/deny, ACLs, VTY ACL) ─────────
//
// AllowUsers / DenyUsers on Linux, access-class on Cisco VTY, acl
// inbound on Huawei VTY, OpenSSH AllowGroups — every server must
// enforce its own ACL before reaching the shell.

describe('§21 — sshd access control', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR1);
    await enableHuaweiSsh(lan.hwR1);
  });

  const rows: Row[] = [
    {
      name: 'Linux: AllowUsers alice rejects bob',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sh -c "echo AllowUsers alice >> /etc/ssh/sshd_config"');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
      },
      on: l => l.linux1, cmd: 'ssh bob@10.0.0.2 hostname',
      contains: [/Permission denied|disallowed/i], excludes: [/^linux2$/m],
    },
    {
      name: 'Linux: DenyUsers bob still lets alice through',
      setup: async (l) => {
        await l.linux2.executeCommand('sudo sh -c "echo DenyUsers bob >> /etc/ssh/sshd_config"');
        await l.linux2.executeCommand('sudo systemctl restart ssh');
      },
      on: l => l.linux1, cmd: 'ssh alice@10.0.0.2 hostname',
      contains: [/^linux2$/m],
    },
    {
      name: 'Cisco: access-class on VTY blocks foreign client IP',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('access-list 20 permit 10.0.0.3');
        await l.ciscoR1.executeCommand('line vty 0 4');
        await l.ciscoR1.executeCommand('access-class 20 in');
        await l.ciscoR1.executeCommand('end');
      },
      on: l => l.linux1, cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.6 "show version"',
      contains: [/Connection (closed|refused)|denied/i],
    },
    {
      name: 'Cisco: access-class still allows the permitted IP',
      setup: async (l) => {
        await l.ciscoR1.executeCommand('configure terminal');
        await l.ciscoR1.executeCommand('access-list 21 permit 10.0.0.1');
        await l.ciscoR1.executeCommand('line vty 0 4');
        await l.ciscoR1.executeCommand('access-class 21 in');
        await l.ciscoR1.executeCommand('end');
      },
      on: l => l.linux1, cmd: 'ssh admin@10.0.0.6 "show version"',
      contains: [/IOS|Cisco/i],
    },
    {
      name: 'Huawei: acl inbound on VTY blocks foreign client IP',
      setup: async (l) => {
        await l.hwR1.executeCommand('system-view');
        await l.hwR1.executeCommand('acl 2000');
        await l.hwR1.executeCommand('rule 5 permit source 10.0.0.3 0');
        await l.hwR1.executeCommand('quit');
        await l.hwR1.executeCommand('user-interface vty 0 4');
        await l.hwR1.executeCommand('acl 2000 inbound');
        await l.hwR1.executeCommand('quit');
        await l.hwR1.executeCommand('quit');
      },
      on: l => l.linux1, cmd: 'ssh -o ConnectTimeout=2 admin@10.0.0.8 "display version"',
      contains: [/Connection (closed|refused)|denied/i],
    },
  ];

  test.each(rows)('$name', async (row) => {
    assertRow(await runRow(lan, row), row);
  });
});
