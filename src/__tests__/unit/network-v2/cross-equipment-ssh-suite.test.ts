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
