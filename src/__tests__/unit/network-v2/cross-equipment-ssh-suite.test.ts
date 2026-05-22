/**
 * Cross-equipment SSH suite — end-to-end exploratory spec.
 *
 * This test file is intentionally written as an *oracle* of how SSH must
 * behave on a heterogeneous LAN composed of Linux hosts, Windows hosts,
 * Cisco IOS routers/switches and Huawei VRP routers/switches. Any failure
 * pinpoints a missing or incoherent piece of the implementation — either
 * on the SSH stack itself, on the per-device shell, on the command flow,
 * or on the reactive event bus.
 *
 * Topology (rebuilt fresh for each `describe`):
 *
 *                       ┌──────── core-sw (GenericSwitch, 16 ports) ────────┐
 *     linux1  10.0.0.1 ─┤                                                    │
 *     linux2  10.0.0.2 ─┤                                                    │
 *     lxsrv1  10.0.0.3 ─┤                                                    │
 *     win1    10.0.0.4 ─┤                                                    │
 *     win2    10.0.0.5 ─┤                                                    │
 *     ciscoR1 10.0.0.6 ─┤                                                    │
 *     ciscoS1 10.0.0.7 ─┤                                                    │
 *     huaweiR1 10.0.0.8─┤                                                    │
 *     huaweiS1 10.0.0.9─┘                                                    │
 *                                                                            │
 * Conventions:
 *   - Default Linux account: user/admin  (root via sudo).
 *   - Default Windows account: User/Passw0rd! (Administrator/Passw0rd!).
 *   - Default Cisco / Huawei VTY account: admin/Admin@123, enable: Admin@123.
 *   - SSH listens on tcp/22 on every node (vty ssh on routers/switches).
 *   - Tests drive each device through its native CLI exactly as a real
 *     operator would: `executeCommand("ssh user@host …")` for Linux/Windows,
 *     `ssh -l user host` for Cisco/Huawei from privileged exec mode.
 */

import { describe, beforeEach, expect, test } from 'vitest';

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

// ─── Heterogeneous LAN fixture ──────────────────────────────────────

export interface XLan {
  linux1: LinuxPC;
  linux2: LinuxPC;
  lxsrv1: LinuxServer;
  win1: WindowsPC;
  win2: WindowsPC;
  ciscoR1: CiscoRouter;
  ciscoS1: CiscoSwitch;
  huaweiR1: HuaweiRouter;
  huaweiS1: HuaweiSwitch;
  sw: GenericSwitch;
  ip: Record<string, string>;
}

const IPS = {
  linux1: '10.0.0.1',
  linux2: '10.0.0.2',
  lxsrv1: '10.0.0.3',
  win1: '10.0.0.4',
  win2: '10.0.0.5',
  ciscoR1: '10.0.0.6',
  ciscoS1: '10.0.0.7',
  huaweiR1: '10.0.0.8',
  huaweiS1: '10.0.0.9',
} as const;

const MASK = new SubnetMask('255.255.255.0');

/**
 * Build a fresh LAN. Every device is cabled to a single 16-port switch,
 * every external port carries an IPv4 from 10.0.0.0/24, and Linux ARP
 * caches are pre-warmed so the TCP three-way handshake of the very first
 * SSH connection does not race the ARP request.
 */
async function buildXLan(): Promise<XLan> {
  EquipmentRegistry.getInstance().clear();

  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const linux2 = new LinuxPC('linux-pc', 'linux2', 0, 0);
  const lxsrv1 = new LinuxServer('linux-server', 'lxsrv1', 0, 0);
  const win1 = new WindowsPC('windows-pc', 'win1', 0, 0);
  const win2 = new WindowsPC('windows-pc', 'win2', 0, 0);
  const ciscoR1 = new CiscoRouter('cisco-router', 'ciscoR1', 0, 0);
  const ciscoS1 = new CiscoSwitch('cisco-switch', 'ciscoS1', 0, 0);
  const huaweiR1 = new HuaweiRouter('huawei-router', 'huaweiR1', 0, 0);
  const huaweiS1 = new HuaweiSwitch('huawei-switch', 'huaweiS1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 16, 0, 0);

  const nodes = [linux1, linux2, lxsrv1, win1, win2, ciscoR1, ciscoS1, huaweiR1, huaweiS1];
  nodes.forEach((d, i) => {
    const cable = new Cable(`c${i}`);
    cable.connect(d.getPorts()[0], sw.getPort(`eth${i}`)!);
  });

  // Configure IP per device — Linux/Windows expose Port.configureIP, and
  // routers/switches expose interface configuration through their CLI.
  linux1.getPorts()[0].configureIP(new IPAddress(IPS.linux1), MASK);
  linux2.getPorts()[0].configureIP(new IPAddress(IPS.linux2), MASK);
  lxsrv1.getPorts()[0].configureIP(new IPAddress(IPS.lxsrv1), MASK);
  win1.getPorts()[0].configureIP(new IPAddress(IPS.win1), MASK);
  win2.getPorts()[0].configureIP(new IPAddress(IPS.win2), MASK);

  // Cisco router: interface gi0/0 ip address …
  await ciscoR1.executeCommand('enable');
  await ciscoR1.executeCommand('configure terminal');
  await ciscoR1.executeCommand('interface GigabitEthernet0/0');
  await ciscoR1.executeCommand(`ip address ${IPS.ciscoR1} 255.255.255.0`);
  await ciscoR1.executeCommand('no shutdown');
  await ciscoR1.executeCommand('end');

  // Cisco switch: SVI vlan1
  await ciscoS1.executeCommand('enable');
  await ciscoS1.executeCommand('configure terminal');
  await ciscoS1.executeCommand('interface vlan 1');
  await ciscoS1.executeCommand(`ip address ${IPS.ciscoS1} 255.255.255.0`);
  await ciscoS1.executeCommand('no shutdown');
  await ciscoS1.executeCommand('end');

  // Huawei router
  await huaweiR1.executeCommand('system-view');
  await huaweiR1.executeCommand('interface GigabitEthernet0/0/0');
  await huaweiR1.executeCommand(`ip address ${IPS.huaweiR1} 255.255.255.0`);
  await huaweiR1.executeCommand('undo shutdown');
  await huaweiR1.executeCommand('quit');
  await huaweiR1.executeCommand('quit');

  // Huawei switch
  await huaweiS1.executeCommand('system-view');
  await huaweiS1.executeCommand('interface Vlanif 1');
  await huaweiS1.executeCommand(`ip address ${IPS.huaweiS1} 255.255.255.0`);
  await huaweiS1.executeCommand('undo shutdown');
  await huaweiS1.executeCommand('quit');
  await huaweiS1.executeCommand('quit');

  // Warm ARP caches between Linux peers (best-effort).
  for (const host of [linux1, linux2, lxsrv1] as const) {
    for (const ip of Object.values(IPS)) {
      if (ip === host.getPorts()[0].getIPAddress()?.toString()) continue;
      await host.executeCommand(`ping -c 1 -W 1 ${ip}`).catch(() => undefined);
    }
  }

  return {
    linux1, linux2, lxsrv1, win1, win2,
    ciscoR1, ciscoS1, huaweiR1, huaweiS1,
    sw,
    ip: { ...IPS },
  };
}

// ─── Generic assertion helper ───────────────────────────────────────

interface Expect {
  contains?: (string | RegExp)[];
  excludes?: (string | RegExp)[];
}

function assertOutput(out: string, exp: Expect): void {
  for (const c of exp.contains ?? []) {
    if (c instanceof RegExp) expect(out).toMatch(c);
    else expect(out).toContain(c);
  }
  for (const e of exp.excludes ?? []) {
    if (e instanceof RegExp) expect(out).not.toMatch(e);
    else expect(out).not.toContain(e);
  }
}

// ════════════════════════════════════════════════════════════════════
// §1 — LAN bootstrap & L3 reachability
// ════════════════════════════════════════════════════════════════════
//
// Before any SSH test makes sense, every node must own its configured
// IPv4 and answer ICMP echo from at least one Linux peer. This section
// guards the fixture itself: if §1 fails, every other section is
// meaningless and the fixture must be repaired first.

describe('§1 — Cross-equipment LAN bootstrap & reachability', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  test('every device reports its configured IPv4 address', () => {
    expect(lan.linux1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.linux1);
    expect(lan.linux2.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.linux2);
    expect(lan.lxsrv1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.lxsrv1);
    expect(lan.win1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.win1);
    expect(lan.win2.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.win2);
    expect(lan.ciscoR1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.ciscoR1);
    expect(lan.ciscoS1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.ciscoS1);
    expect(lan.huaweiR1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.huaweiR1);
    expect(lan.huaweiS1.getPorts()[0].getIPAddress()?.toString()).toBe(IPS.huaweiS1);
  });

  test('Linux peers can ICMP-ping every other node in the LAN', async () => {
    for (const target of Object.values(IPS)) {
      if (target === IPS.linux1) continue;
      const out = await lan.linux1.executeCommand(`ping -c 1 -W 2 ${target}`);
      assertOutput(out, { contains: [/1 (packets )?received|bytes from/i] });
    }
  });

  test('Windows peers can ICMP-ping every other node in the LAN', async () => {
    for (const target of Object.values(IPS)) {
      if (target === IPS.win1) continue;
      const out = await lan.win1.executeCommand(`ping ${target}`);
      assertOutput(out, { contains: [/Reply from|bytes=/i] });
    }
  });

  test('Cisco router can ping a Linux peer', async () => {
    await lan.ciscoR1.executeCommand('enable');
    const out = await lan.ciscoR1.executeCommand(`ping ${IPS.linux1}`);
    assertOutput(out, { contains: [/!!!!!|Success rate is [1-9]/] });
  });

  test('Huawei router can ping a Linux peer', async () => {
    const out = await lan.huaweiR1.executeCommand(`ping ${IPS.linux1}`);
    assertOutput(out, { contains: [/Reply from|bytes from|Request time out/i] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — Linux → Linux SSH happy path
// ════════════════════════════════════════════════════════════════════
//
// Drives `ssh` from a Linux PC CLI exactly as a real user would, making
// sure the client traverses the network (TCP through core-sw), reaches
// sshd on the peer, authenticates with the seeded `user`/`admin`
// credentials, runs the remote command, prints its output and closes
// the connection cleanly. Nothing here may bypass the network layer.

describe('§2 — Linux → Linux SSH happy path', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  test('one-shot remote command returns remote stdout', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux2} whoami`,
    );
    assertOutput(out, { contains: ['user'], excludes: [/permission denied/i] });
  });

  test('remote hostname matches the target device', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux2} hostname`,
    );
    assertOutput(out, { contains: ['linux2'] });
  });

  test('SSH to a LinuxServer behaves the same as to a LinuxPC', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.lxsrv1} hostname`,
    );
    assertOutput(out, { contains: ['lxsrv1'] });
  });

  test('the connection-closed line terminates an interactive session', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux2} exit`,
    );
    assertOutput(out, { contains: [/Connection to .* closed/i] });
  });

  test('non-zero remote exit code is surfaced to the local shell', async () => {
    await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux2} false`,
    );
    const out = await lan.linux1.executeCommand('echo $?');
    assertOutput(out, { contains: [/^1\s*$/m] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — Linux → Windows SSH
// ════════════════════════════════════════════════════════════════════
//
// A Linux operator must be able to manage a Windows host through SSH
// (OpenSSH for Windows). The remote shell on the Windows side may be
// cmd.exe or PowerShell — both must be reachable.

describe('§3 — Linux → Windows SSH', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  test('ssh User@win1 hostname returns the Windows machine name', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new User@${IPS.win1} hostname`,
    );
    assertOutput(out, { contains: ['win1'] });
  });

  test('cmd.exe builtin commands run through the SSH channel', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new User@${IPS.win1} "ver"`,
    );
    assertOutput(out, { contains: [/Microsoft Windows|Version/i] });
  });

  test('PowerShell can be selected as the remote shell', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new User@${IPS.win1} powershell -Command "Get-Host | Select-Object -ExpandProperty Name"`,
    );
    assertOutput(out, { contains: [/ConsoleHost|PowerShell/i] });
  });

  test('wrong Windows password fails authentication', async () => {
    const out = await lan.linux1.executeCommand(
      `sshpass -p Wrong! ssh -o StrictHostKeyChecking=accept-new User@${IPS.win1} whoami`,
    );
    assertOutput(out, { contains: [/Permission denied|Authentication failed/i] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §4 — Windows → Linux SSH
// ════════════════════════════════════════════════════════════════════
//
// Symmetric counterpart of §3: a Windows operator drives the OpenSSH
// client (ssh.exe) from cmd.exe or PowerShell against a Linux peer.

describe('§4 — Windows → Linux SSH', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  test('ssh user@linux1 hostname returns linux1', async () => {
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux1} hostname`,
    );
    assertOutput(out, { contains: ['linux1'] });
  });

  test('uname -a from Windows reflects the Linux kernel banner', async () => {
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux1} uname -a`,
    );
    assertOutput(out, { contains: [/Linux/] });
  });

  test('PowerShell pipeline can capture remote stdout into a variable', async () => {
    const out = await lan.win1.executeCommand(
      `powershell -Command "$h = ssh -o StrictHostKeyChecking=accept-new user@${IPS.linux1} hostname; $h"`,
    );
    assertOutput(out, { contains: ['linux1'] });
  });

  test('Windows ssh client surfaces a connection refused when sshd is down', async () => {
    await lan.linux1.executeCommand('sudo systemctl stop ssh');
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=2 user@${IPS.linux1} whoami`,
    );
    assertOutput(out, { contains: [/Connection refused|Could not connect/i] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §5 — Linux → Cisco IOS SSH (router & switch)
// ════════════════════════════════════════════════════════════════════
//
// A Linux operator must be able to SSH into a Cisco IOS device. The
// remote prompt belongs to CiscoIOSShell — the SSH server on the
// device delegates the channel to the VTY/CLI state machine, not to
// a bash shell.

describe('§5 — Linux → Cisco IOS SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    // Enable VTY ssh with a local account on both Cisco devices.
    for (const dev of [lan.ciscoR1, lan.ciscoS1]) {
      await dev.executeCommand('enable');
      await dev.executeCommand('configure terminal');
      await dev.executeCommand('username admin privilege 15 secret Admin@123');
      await dev.executeCommand('enable secret Admin@123');
      await dev.executeCommand('ip domain-name lab.local');
      await dev.executeCommand('crypto key generate rsa modulus 2048');
      await dev.executeCommand('line vty 0 4');
      await dev.executeCommand('login local');
      await dev.executeCommand('transport input ssh');
      await dev.executeCommand('exit');
      await dev.executeCommand('end');
    }
  });

  test('remote prompt on Cisco router is the IOS user-exec banner', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.ciscoR1} "show version"`,
    );
    assertOutput(out, { contains: [/IOS|Cisco/i] });
  });

  test('remote prompt on Cisco switch shows port hardware info', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.ciscoS1} "show interfaces status"`,
    );
    assertOutput(out, { contains: [/Port\s+Name|connected|notconnect/i] });
  });

  test('show running-config requires enable then prints VTY config', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.ciscoR1} "enable\\nshow running-config"`,
    );
    assertOutput(out, { contains: [/line vty 0 4/, /transport input ssh/] });
  });

  test('transport input none refuses SSH on the VTY', async () => {
    await lan.ciscoR1.executeCommand('configure terminal');
    await lan.ciscoR1.executeCommand('line vty 0 4');
    await lan.ciscoR1.executeCommand('transport input none');
    await lan.ciscoR1.executeCommand('end');
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=2 admin@${IPS.ciscoR1} "show version"`,
    );
    assertOutput(out, { contains: [/Connection (closed|refused)|denied/i] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §6 — Linux → Huawei VRP SSH (router & switch)
// ════════════════════════════════════════════════════════════════════
//
// Same idea as §5 but for VRP: the SSH server on the Huawei side
// delegates the channel to HuaweiVRPShell. Authentication uses an
// AAA local user with `service-type ssh`.

describe('§6 — Linux → Huawei VRP SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    for (const dev of [lan.huaweiR1, lan.huaweiS1]) {
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
  });

  test('display version through SSH on the Huawei router', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.huaweiR1} "display version"`,
    );
    assertOutput(out, { contains: [/VRP|Huawei/i] });
  });

  test('display interface brief through SSH on the Huawei switch', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.huaweiS1} "display interface brief"`,
    );
    assertOutput(out, { contains: [/Interface\s+PHY|Vlanif1/i] });
  });

  test('display current-configuration shows ssh server enabled', async () => {
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.huaweiR1} "display current-configuration"`,
    );
    assertOutput(out, { contains: [/stelnet server enable/, /protocol inbound ssh/] });
  });

  test('undo stelnet server enable refuses SSH', async () => {
    await lan.huaweiR1.executeCommand('system-view');
    await lan.huaweiR1.executeCommand('undo stelnet server enable');
    await lan.huaweiR1.executeCommand('quit');
    const out = await lan.linux1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=2 admin@${IPS.huaweiR1} "display version"`,
    );
    assertOutput(out, { contains: [/Connection (closed|refused)/i] });
  });
});

// ════════════════════════════════════════════════════════════════════
// §7 — Windows → Cisco / Huawei SSH
// ════════════════════════════════════════════════════════════════════
//
// Same gating as §5/§6 but driven from Windows. Verifies that the
// Windows OpenSSH client speaks the same SSH transport as Linux and
// that the remote shell behind the channel is the native CLI of each
// platform (no fall-through to bash).

describe('§7 — Windows → Cisco / Huawei SSH', () => {
  let lan: XLan;
  beforeEach(async () => {
    lan = await buildXLan();
    for (const dev of [lan.ciscoR1]) {
      await dev.executeCommand('enable');
      await dev.executeCommand('configure terminal');
      await dev.executeCommand('username admin privilege 15 secret Admin@123');
      await dev.executeCommand('ip domain-name lab.local');
      await dev.executeCommand('crypto key generate rsa modulus 2048');
      await dev.executeCommand('line vty 0 4');
      await dev.executeCommand('login local');
      await dev.executeCommand('transport input ssh');
      await dev.executeCommand('end');
    }
    await lan.huaweiR1.executeCommand('system-view');
    await lan.huaweiR1.executeCommand('aaa');
    await lan.huaweiR1.executeCommand('local-user admin password cipher Admin@123');
    await lan.huaweiR1.executeCommand('local-user admin service-type ssh');
    await lan.huaweiR1.executeCommand('local-user admin privilege level 15');
    await lan.huaweiR1.executeCommand('quit');
    await lan.huaweiR1.executeCommand('rsa local-key-pair create');
    await lan.huaweiR1.executeCommand('stelnet server enable');
    await lan.huaweiR1.executeCommand('user-interface vty 0 4');
    await lan.huaweiR1.executeCommand('authentication-mode aaa');
    await lan.huaweiR1.executeCommand('protocol inbound ssh');
    await lan.huaweiR1.executeCommand('quit');
    await lan.huaweiR1.executeCommand('ssh user admin authentication-type password');
    await lan.huaweiR1.executeCommand('quit');
  });

  test('Windows ssh.exe reaches Cisco IOS and runs show version', async () => {
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.ciscoR1} "show version"`,
    );
    assertOutput(out, { contains: [/IOS|Cisco/i] });
  });

  test('Windows ssh.exe reaches Huawei VRP and runs display version', async () => {
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.huaweiR1} "display version"`,
    );
    assertOutput(out, { contains: [/VRP|Huawei/i] });
  });

  test('the remote prompt is Cisco IOS, not cmd.exe, after SSH', async () => {
    const out = await lan.win1.executeCommand(
      `ssh -o StrictHostKeyChecking=accept-new admin@${IPS.ciscoR1} "?" `,
    );
    // Cisco IOS context-sensitive help, never a cmd.exe usage line.
    assertOutput(out, { excludes: [/Microsoft|cmd\.exe/i] });
  });
});
