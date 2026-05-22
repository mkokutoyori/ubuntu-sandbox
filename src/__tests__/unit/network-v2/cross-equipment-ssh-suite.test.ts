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
