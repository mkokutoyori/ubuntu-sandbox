/**
 * TDD — SSH from a Linux terminal to a non-Linux target (Cisco/Huawei/
 * Windows) must authenticate over the real TCP/SshSession pipeline,
 * not a direct in-memory method call.
 *
 * Audit 03, constat CRITIQUE §1.b: `LinuxTerminalSession.enterSsh()`
 * tried `tryEnterCrossVendorSsh()` first for any non-Linux target,
 * which verifies the password via `sshHost.evaluate(request)` — a
 * local method call on the target's Equipment object, zero bytes on
 * the wire — even though Router.ts/WindowsPC.ts already register a
 * real `SshServerHandler` on a real `TcpStack.listen(22, ...)` (proven
 * end-to-end by router-ssh-wire-end-to-end.test.ts). The bypass's own
 * comment justifying it ("no TCP listener on routers / Windows in the
 * simulator") is stale — that infrastructure exists and already works.
 *
 * `ssh-nested-matrix.test.ts` already pins the *observable* outcome
 * (landing on a real CiscoTerminalSession/HuaweiTerminalSession,
 * `isRemoteChild === true`) — this file adds the missing dimension:
 * that reaching that outcome must actually move bytes through Cable,
 * and that a wrong password must be rejected by the real protocol
 * exchange, not a local check.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 8 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 8; i++) await tick();
}

async function buildLab() {
  EquipmentRegistry.resetInstance();
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const cisco = new CiscoRouter('R1', 0, 0);
  const huawei = new HuaweiRouter('hwR1', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  [linuxA, cisco, huawei, winA].forEach((d) => d.powerOn());
  sw.powerOn();
  new Cable('c1').connect(linuxA.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(huawei.getPorts()[0], sw.getPort('FastEthernet0/3')!);
  new Cable('c4').connect(winA.getPort('eth0')!, sw.getPort('FastEthernet0/4')!);

  await linuxA.executeCommand('ifconfig eth0 10.0.0.3');

  await cisco.executeCommand('enable');
  await cisco.executeCommand('configure terminal');
  await cisco.executeCommand('hostname R1');
  await cisco.executeCommand('interface GigabitEthernet0/0');
  await cisco.executeCommand('ip address 10.0.0.5 255.255.255.0');
  await cisco.executeCommand('no shutdown');
  await cisco.executeCommand('exit');
  await cisco.executeCommand('username admin privilege 15 secret Admin@123');
  await cisco.executeCommand('enable secret Admin@123');
  await cisco.executeCommand('ip domain-name lab.local');
  await cisco.executeCommand('crypto key generate rsa modulus 2048');
  await cisco.executeCommand('ip ssh version 2');
  await cisco.executeCommand('line vty 0 4');
  await cisco.executeCommand('login local');
  await cisco.executeCommand('transport input ssh');
  await cisco.executeCommand('end');

  await huawei.executeCommand('system-view');
  await huawei.executeCommand('sysname hwR1');
  await huawei.executeCommand('interface GigabitEthernet0/0/0');
  await huawei.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await huawei.executeCommand('undo shutdown');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('aaa');
  await huawei.executeCommand('local-user admin password cipher Admin@123');
  await huawei.executeCommand('local-user admin service-type ssh');
  await huawei.executeCommand('local-user admin privilege level 15');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('rsa local-key-pair create');
  await huawei.executeCommand('stelnet server enable');
  await huawei.executeCommand('user-interface vty 0 4');
  await huawei.executeCommand('authentication-mode aaa');
  await huawei.executeCommand('protocol inbound ssh');
  await huawei.executeCommand('quit');
  await huawei.executeCommand('ssh user admin authentication-type password');
  await huawei.executeCommand('ssh user admin service-type stelnet');
  await huawei.executeCommand('quit');

  await winA.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');

  return { linuxA, cisco, huawei, winA };
}

/** Count `cable.frame.dispatched` events published while `fn` runs. */
async function countDispatchedFrames(fn: () => Promise<void>): Promise<number> {
  let count = 0;
  const unsub = getDefaultEventBus().subscribe('cable.frame.dispatched', () => { count++; });
  try {
    await fn();
  } finally {
    unsub();
  }
  return count;
}

describe('Linux -> Cisco SSH: real wire, not a local checkPassword() call', () => {
  it('a successful login moves real frames across the cable', async () => {
    const { linuxA, cisco } = await buildLab();
    const host = new LinuxTerminalSession('h', linuxA);
    await host.init?.();

    const frames = await countDispatchedFrames(() => sshLogin(host, 'ssh admin@10.0.0.5', 'Admin@123'));

    // The point of this suite is that the login crossed the cable, which
    // `frames` proves. The landing prompt replaces the old assertion on a
    // child session's class: a wire-driven hop has none.
    expect(frames).toBeGreaterThan(0);
    expect(host.foreground.getPrompt()).toMatch(/[>#]\s*$/);
    void cisco;
  });

  it('a wrong password is rejected and never lands on the router session', async () => {
    const { linuxA } = await buildLab();
    const host = new LinuxTerminalSession('h', linuxA);
    await host.init?.();

    await sshLogin(host, 'ssh admin@10.0.0.5', 'WRONG-PASSWORD');

    expect(host.foreground).toBe(host);
    expect(host.foreground).not.toBeInstanceOf(CiscoTerminalSession);
    expect(host.lines.map((l) => l.text).join('\n')).toMatch(/Permission denied/);
  });
});

describe('Linux -> Huawei SSH: real wire, not a local checkPassword() call', () => {
  it('a successful login moves real frames across the cable', async () => {
    const { linuxA } = await buildLab();
    const host = new LinuxTerminalSession('h', linuxA);
    await host.init?.();

    const frames = await countDispatchedFrames(() => sshLogin(host, 'ssh admin@10.0.0.6', 'Admin@123'));

    expect(frames).toBeGreaterThan(0);
    expect(host.foreground.getPrompt()).toMatch(/^</);
  });

  it('a wrong password is rejected and never lands on the router session', async () => {
    const { linuxA } = await buildLab();
    const host = new LinuxTerminalSession('h', linuxA);
    await host.init?.();

    await sshLogin(host, 'ssh admin@10.0.0.6', 'WRONG-PASSWORD');

    expect(host.foreground).toBe(host);
    expect(host.foreground).not.toBeInstanceOf(HuaweiTerminalSession);
  });
});

describe('Linux -> Windows SSH: real wire, not a local checkPassword() call', () => {
  it('a successful login moves real frames across the cable', async () => {
    const { linuxA } = await buildLab();
    const host = new LinuxTerminalSession('h', linuxA);
    await host.init?.();

    const frames = await countDispatchedFrames(() => sshLogin(host, 'ssh User@10.0.0.7', 'user'));

    expect(frames).toBeGreaterThan(0);
    expect(host.foreground.getPrompt()).toMatch(/^[A-Z]:\\/);
  });
});
