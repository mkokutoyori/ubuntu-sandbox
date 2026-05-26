/**
 * Advanced 15-scenario suite — exercises the shell/terminal/session
 * decoupling, deep cross-vendor SSH chains, prompt integrity, password
 * propagation, ANSI cross-vendor rendering, and connection-awareness.
 *
 * Every scenario corresponds to a user-visible behaviour we want to
 * guarantee at the architectural seam between Shell, Session and View.
 * Failure tail printing helps diagnosis when something regresses.
 */

import { describe, expect, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

// ───────────────────────────── helpers ─────────────────────────────

function key(k: string, opts: { ctrlKey?: boolean; shiftKey?: boolean } = {}): KeyEvent {
  return {
    key: k,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: false,
    metaKey: false,
    shiftKey: opts.shiftKey ?? false,
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function typeRoot(t: TerminalSession, line: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
}

async function typeSub(t: TerminalSession, line: string): Promise<void> {
  t.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

async function winSshLogin(t: WindowsTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  for (let i = 0; i < 4 && t.currentInputMode.type !== 'normal'; i++) {
    if (t.currentInputMode.type === 'password') t.setPasswordBuf(pw);
    else if (t.currentInputMode.type === 'interactive-text') t.setInputBuf('yes');
    else break;
    t.handleKey(key('Enter'));
    await flush();
  }
}

async function linuxSshLogin(t: LinuxTerminalSession, line: string, pw: string): Promise<void> {
  await typeRoot(t, line);
  for (let i = 0; i < 4 && t.currentInputMode.type !== 'normal'; i++) {
    if (t.currentInputMode.type === 'password') t.setPasswordBuf(pw);
    else if (t.currentInputMode.type === 'interactive-text') t.setInputBuf('yes');
    else break;
    t.handleKey(key('Enter'));
    await flush();
  }
}

function expectAnyLine(t: TerminalSession, needle: string | RegExp, label = ''): void {
  const ok = t.lines.some((l) =>
    needle instanceof RegExp ? needle.test(l.text) : l.text.includes(needle),
  );
  if (!ok) {
    const tail = t.lines.slice(-20).map((l) => l.text).join('\n');
    throw new Error(`Missing ${String(needle)} ${label}\n--tail--\n${tail}`);
  }
}

function lastFew(t: TerminalSession, n = 6): string {
  return t.lines.slice(-n).map((l) => l.text).join('\n');
}

// ───────────────────────────── LAN ─────────────────────────────────

async function buildLan() {
  EquipmentRegistry.getInstance().clear();
  reinstallDefaultShells();

  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const cisco = new CiscoRouter('cisco', 0, 0);
  const huawei = new HuaweiRouter('huawei', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 16, 0, 0);
  const mask = new SubnetMask('255.255.255.0');

  [linuxA, linuxSrv, winA, winB, cisco, huawei].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linuxSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), mask);
  linuxA.setHostname('linuxA');
  linuxSrv.setHostname('linuxSrv');
  winA.setHostname('winA');
  winB.setHostname('winB');

  // Configure Cisco for SSH login: admin / Admin@123
  await cisco.executeCommand('enable');
  await cisco.executeCommand('configure terminal');
  await cisco.executeCommand('interface GigabitEthernet0/0');
  await cisco.executeCommand('ip address 10.0.0.6 255.255.255.0');
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

  // Configure Huawei for SSH login: admin / Admin@123
  await huawei.executeCommand('system-view');
  await huawei.executeCommand('interface GigabitEthernet0/0/0');
  await huawei.executeCommand('ip address 10.0.0.7 255.255.255.0');
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

  return { linuxA, linuxSrv, winA, winB, cisco, huawei };
}

// ───────────────────────────── tests ───────────────────────────────

describe('Shell layer — 15 advanced scenarios (TDD)', () => {
  // ── #1 — ANSI cross-vendor render ──────────────────────────────
  test('§1 — Win→SSH→Linux: ls output is rendered as styled segments, no raw ANSI', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls /');
    // No line should contain raw [1;36m or [0m
    // eslint-disable-next-line no-control-regex
    const hasRawAnsi = t.lines.some((l) => /\x1b\[/.test(l.text) || /\[1;3\dm/.test(l.text));
    if (hasRawAnsi) {
      throw new Error(`Raw ANSI escapes leaked into output:\n${lastFew(t, 8)}`);
    }
    // And the lines must carry styled segments (proof the shell pushed
    // pre-styled output through the SSH wrapper).
    const styledCount = t.lines.filter((l) => l.segments && l.segments.length > 0).length;
    expect(styledCount).toBeGreaterThan(0);
  });

  // ── #2 — cwd sync over SSH ─────────────────────────────────────
  test('§2 — Win→SSH→Linux: cd /tmp updates the prompt to :/tmp$', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv:~\$/);
    await typeSub(t, 'cd /tmp');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv:\/tmp\$/);
    await typeSub(t, 'cd /');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv:\/\$/);
  });

  // ── #3 — Shell knows it is SSH-driven ──────────────────────────
  test('§3 — Win→SSH→Linux: the active shell knows connection==="ssh"', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Reach into the adapter that wraps CrossVendorRemoteShell.
    const adapter = (t as unknown as { activeSubShell: { inner?: { connection: string } } }).activeSubShell;
    expect(adapter).toBeTruthy();
    expect(adapter.inner?.connection).toBe('ssh');
  });

  // ── #4 — Password mode propagates through SSH ──────────────────
  test('§4 — Win→SSH→Linux: sudo over SSH triggers password input mode', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // First sudo should ask for alice's password (no cached creds in this session).
    await typeSub(t, 'sudo whoami');
    // Either we landed in password input mode, or the simulator gates by
    // running the command directly — accept either, but no raw '[sudo]'
    // string should be left dangling on the screen with no follow-up.
    if (t.currentInputMode.type === 'password') {
      // Provide the password.
      t.setPasswordBuf('alice');
      t.handleKey(key('Enter'));
      await flush();
    }
    expectAnyLine(t, /^root$/);
  });

  // ── #5 — Cisco prompt over SSH ─────────────────────────────────
  test('§5 — Win→SSH→Cisco: shows Router> prompt and enable→Router#', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(t.getPrompt()).toMatch(/^R1[#>]\s?$/);
    if (/>\s?$/.test(t.getPrompt())) {
      await typeSub(t, 'enable');
      if (t.currentInputMode.type === 'password') {
        t.setPasswordBuf('Admin@123');
        t.handleKey(key('Enter'));
        await flush();
      }
    }
    expect(t.getPrompt()).toMatch(/^R1#\s?$/);
  });

  // ── #6 — Huawei prompt over SSH ────────────────────────────────
  test('§6 — Win→SSH→Huawei: shows <HW> prompt and system-view→[HW]', async () => {
    const { winA, huawei } = await buildLan();
    huawei.setHostname('HW');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');
    expect(t.getPrompt()).toMatch(/^<HW>\s?$/);
    await typeSub(t, 'system-view');
    expect(t.getPrompt()).toMatch(/^\[HW\]\s?$/);
  });

  // ── #7 — clear works through any vendor ────────────────────────
  test('§7 — Win→SSH→Linux: `clear` wipes the screen', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo hello');
    expect(t.lines.length).toBeGreaterThan(0);
    await typeSub(t, 'clear');
    // After clear, the visible scrollback should contain very few
    // lines (the prompt for the next command at most).
    expect(t.lines.length).toBeLessThanOrEqual(2);
  });

  // ── #8 — exit produces logout + closed footer ──────────────────
  test('§8 — Win→SSH→Linux: exit prints "logout" and "Connection to ... closed."', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    expectAnyLine(t, /logout/);
    expectAnyLine(t, /Connection to 10\.0\.0\.3 closed\./);
  });

  // ── #9 — Tab completion routes to the top-of-stack shell ───────
  test('§9 — Win→SSH→Linux: TAB completes /et → /etc on the remote bash', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    t.setInputBuf('ls /et');
    t.handleKey(key('Tab'));
    await flush();
    // The remote bash's completion should have rewritten the input buffer.
    const buf = (t as unknown as { getInputBuf(): string }).getInputBuf();
    expect(buf).toMatch(/\/etc/);
  });

  // ── #10 — Ctrl+C cancels the current sub-shell line ────────────
  test('§10 — Win→SSH→Linux: Ctrl+C cancels current line and re-prompts', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    t.setInputBuf('some-long-typo');
    t.handleKey(key('c', { ctrlKey: true }));
    await flush();
    const buf = (t as unknown as { getInputBuf(): string }).getInputBuf();
    expect(buf).toBe('');
    expectAnyLine(t, /\^C/);
  });

  // ── #11 — PowerShell over SSH (Win→SSH→Win) ────────────────────
  test('§11 — Win→SSH→Win: launching powershell gives a PS C:\\... prompt', async () => {
    const { winA, winB } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // Bootstrap a local user "user" on winB so SSH can let us in.
    // Test harness convention: WindowsPC accepts any password for the
    // default 'user' account.
    await winSshLogin(t, 'ssh user@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS C:\\Users\\user>/);
  });

  // ── #12 — Nested cmd from PowerShell ───────────────────────────
  test('§12 — Win→SSH→Win→PS→cmd: nested cmd pushes another frame', async () => {
    const { winA, winB } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh user@10.0.0.5', 'user');
    await typeSub(t, 'powershell');
    await typeSub(t, 'cmd');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    await typeSub(t, 'exit');
    // Back to PowerShell after one exit.
    expect(t.getPrompt()).toMatch(/^PS /);
  });

  // ── #13 — clear on Cisco IOS via SSH wipes screen ──────────────
  test('§13 — Win→SSH→Cisco: `clear` (or `clear screen`) wipes the terminal', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show version');
    const before = t.lines.length;
    await typeSub(t, 'clear');
    expect(t.lines.length).toBeLessThan(before);
  });

  // ── #14 — Output lines carry segments after SSH ────────────────
  test('§14 — Win→SSH→Linux: output OutputLines carry segments (not just .text)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo hello-from-remote');
    const echoed = t.lines.find((l) => l.text.includes('hello-from-remote') && !l.text.includes('echo'));
    expect(echoed).toBeTruthy();
    expect(echoed!.segments).toBeTruthy();
    expect(echoed!.segments!.length).toBeGreaterThan(0);
  });

  // ── #15 — Deep chain: Win→SSH→Linux→ssh→Linux ──────────────────
  test('§15 — Win→SSH→Linux→SSH→Linux: prompt reflects deepest host; exit unwinds one frame', async () => {
    const { winA, linuxA } = await buildLan();
    // Make linuxA reachable by alice too (default LinuxPC user).
    linuxA.setHostname('linuxA');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/@linuxSrv/);
    // Now ssh from the remote bash into linuxA.
    await typeSub(t, 'ssh alice@10.0.0.1');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice');
      t.handleKey(key('Enter'));
      await flush();
    } else {
      // Some flows expose the sub-shell password mode differently:
      // sub-shells own the password challenge themselves. Provide it
      // through the next typed line if applicable.
    }
    // After the second hop, prompt should show linuxA.
    expect(t.getPrompt()).toMatch(/@linuxA/);
    await typeSub(t, 'exit');
    // After one exit, back to linuxSrv.
    expect(t.getPrompt()).toMatch(/@linuxSrv/);
  });
});
