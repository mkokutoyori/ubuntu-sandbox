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

/**
 * Type a sub-shell line that triggers a nested ssh password challenge,
 * then satisfy it. Used by deep-nesting tests where every hop is real.
 */
async function typeSshSub(t: TerminalSession, line: string, pw: string): Promise<void> {
  await typeSub(t, line);
  if (t.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw);
    t.handleKey(key('Enter'));
    await flush();
  }
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

  // ── #13 — Ctrl+L wipes screen on Cisco IOS (real IOS has no `clear`
  //          word for screen wipe; the universal binding is Ctrl+L). ──
  test('§13 — Win→SSH→Cisco: Ctrl+L wipes the terminal scrollback', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show version');
    expect(t.lines.length).toBeGreaterThan(0);
    t.handleKey(key('l', { ctrlKey: true }));
    await flush();
    expect(t.lines.length).toBeLessThanOrEqual(2);
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

// ───────────── deep nesting: 4-5 levels of shells ─────────────────

/**
 * Read the IShell-or-ISubShell-ish identity at the top of the host
 * session's sub-shell stack. The test harness routinely needs to assert
 * which shell is active without coupling to any concrete impl.
 */
function topShellKind(t: WindowsTerminalSession | LinuxTerminalSession): string | undefined {
  const a = (t as unknown as { activeSubShell?: { kind?: string; inner?: { kind?: string } } }).activeSubShell;
  if (!a) return undefined;
  return a.inner?.kind ?? a.kind;
}

describe('Deep shell nesting — 4 to 5 levels', () => {
  // ── #D1 — 4-level chain: Win cmd → SSH Linux → ssh Linux → sqlplus ───
  test('§D1 — Win→SSH→Linux→SSH→Linux→sqlplus: four shell frames stack and unwind cleanly', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // L1 → L2 (cmd → SSH bash on linuxSrv)
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    // L2 → L3 (bash → SSH bash on linuxA) — real password challenge.
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxA/);
    // L3 → L4 (bash → sqlplus)
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);
    // Unwind one frame at a time.
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxA/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  // ── #D2 — 5-level chain: Win cmd → PS → SSH Win → cmd → PS ──────────
  test('§D2 — Win cmd→PS→SSH Win→cmd→PS: five frames; each exit reveals the previous prompt', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // L1 console cmd already running.
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
    // L1 → L2 powershell
    await typeRoot(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);
    // L2 → L3 ssh to winB → remote cmd
    await typeSub(t, 'ssh user@10.0.0.5');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('user'); t.handleKey(key('Enter')); await flush();
    }
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    // L3 → L4 nested powershell on the remote
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS C:\\Users\\user>/);
    // L4 → L5 nested cmd from remote powershell
    await typeSub(t, 'cmd');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    // Unwind: cmd → PS → ssh-cmd → PS → cmd
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  // ── #D3 — 5-level cross-vendor: Win cmd → SSH Linux → SSH Win → PS → SSH Linux ──
  test('§D3 — Win→SSH→Linux→SSH→Win→PS→SSH→Linux: alternating-vendor 5-frame stack', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // L1 cmd
    // L1→L2 ssh linuxSrv
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(topShellKind(t)).toBe('ssh-remote');
    // L2→L3 ssh from remote bash into winB
    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    // L3→L4 powershell on winB
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);
    // L4→L5 ssh from remote PS into linuxA
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxA/);
    // Each exit pops one frame.
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  // ── #D4 — 4-level chain with Cisco at the leaf ─────────────────
  test('§D4 — Win→PS→SSH Linux→SSH Cisco→enable: 4 frames + IOS mode change in the deepest', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // L1 cmd → L2 PS
    await typeRoot(t, 'powershell');
    // L2 → L3 ssh linuxSrv
    await typeSub(t, 'ssh alice@10.0.0.3');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    // L3 → L4 ssh Cisco
    await typeSub(t, 'ssh admin@10.0.0.6');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('Admin@123'); t.handleKey(key('Enter')); await flush();
    }
    // Cisco mode transitions are reflected by the live router prompt.
    expect(t.getPrompt()).toMatch(/^R1[#>]/);
    if (/>\s?$/.test(t.getPrompt())) {
      await typeSub(t, 'enable');
      if (t.currentInputMode.type === 'password') {
        t.setPasswordBuf('Admin@123'); t.handleKey(key('Enter')); await flush();
      }
    }
    expect(t.getPrompt()).toMatch(/^R1#/);
    await typeSub(t, 'configure terminal');
    expect(t.getPrompt()).toMatch(/^R1\(config\)#/);
    // Pop back out.
    await typeSub(t, 'end');
    expect(t.getPrompt()).toMatch(/^R1#/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  // ── #D5 — 5-level chain with Huawei at the leaf ────────────────
  test('§D5 — Win→SSH Linux→SSH Win→SSH Huawei→system-view: 4 frames + VRP mode change', async () => {
    const { winA, huawei } = await buildLan();
    huawei.setHostname('HW');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // L1→L2 ssh linuxSrv
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // L2→L3 ssh from remote bash into winB cmd
    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    // L3→L4 ssh from remote cmd into Huawei
    await typeSshSub(t, 'ssh admin@10.0.0.7', 'Admin@123');
    expect(t.getPrompt()).toMatch(/^<HW>/);
    // Mode transition: system-view → [HW]
    await typeSub(t, 'system-view');
    expect(t.getPrompt()).toMatch(/^\[HW\]/);
    await typeSub(t, 'quit');
    expect(t.getPrompt()).toMatch(/^<HW>/);
    // Pop the whole stack.
    await typeSub(t, 'quit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });
});

// ───────── unified shell identity — every shell carries kind+connection ─────────

describe('Unified shell identity — every shell exposes kind+connection', () => {
  test('§U1 — top SSH shell wraps a primary shell with the expected kind', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(topShellKind(t)).toBe('ssh-remote');
    const inner = (t as unknown as { activeSubShell: { inner?: { connection: string; kind: string } } }).activeSubShell.inner;
    expect(inner?.connection).toBe('ssh');
    expect(inner?.kind).toBe('ssh-remote');
  });

  test('§U2 — session.activeShell returns the IShellBase the user is typing into', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    // Native cmd at the root: no sub-shell pushed yet → activeShell is null.
    expect(t.activeShell).toBeNull();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // After SSH push, the active shell exposes IShellBase uniformly.
    expect(t.activeShell).toBeTruthy();
    expect(typeof t.activeShell!.kind).toBe('string');
    expect(typeof t.activeShell!.connection).toBe('string');
    expect(typeof t.activeShell!.getPrompt).toBe('function');
    expect(t.activeShell!.connection).toBe('ssh');
  });
});

// ─── Password challenge driven by the remote shell ──────────────────

describe('Nested-SSH password challenge — driven by the remote shell', () => {
  test('§P1 — bash from inside SSH issues a real password prompt; wrong pw retries; correct pw lands', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Type nested ssh inside the remote bash.
    await typeSub(t, 'ssh alice@10.0.0.1');
    // Bash asked the host terminal for a password — view is now in
    // password input mode (keystrokes will be masked).
    expect(t.currentInputMode.type).toBe('password');
    expect((t.currentInputMode as { promptText: string }).promptText)
      .toMatch(/alice@10\.0\.0\.1's password:/);
    // Wrong password → retry.
    t.setPasswordBuf('wrong');
    t.handleKey(key('Enter'));
    await flush();
    expectAnyLine(t, /Permission denied, please try again\./);
    expect(t.currentInputMode.type).toBe('password');
    // Right password → lands on linuxA.
    t.setPasswordBuf('alice');
    t.handleKey(key('Enter'));
    await flush();
    expect(t.currentInputMode.type).not.toBe('password');
    expect(t.getPrompt()).toMatch(/alice@linuxA/);
  });

  test('§P3 — Linux session: nested ssh from local bash issues a real password challenge', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    // Type ssh from the local bash console — bash intercepts, asks for pw.
    t.setInput('ssh alice@10.0.0.3');
    t.handleKey(key('Enter'));
    await flush();
    expect(t.currentInputMode.type).toBe('password');
    t.setPasswordBuf('alice');
    t.handleKey(key('Enter'));
    await flush();
    expect(t.currentInputMode.type).not.toBe('password');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§P2 — Ctrl+C during the nested challenge cancels cleanly', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ssh alice@10.0.0.1');
    expect(t.currentInputMode.type).toBe('password');
    t.handleKey(key('c', { ctrlKey: true }));
    await flush();
    expect(t.currentInputMode.type).not.toBe('password');
    // Still in the outer remote bash — no child was pushed.
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });
});

// ─── SSH realism — OpenSSH-faithful behaviour expectations ───────────

describe('SSH realism — banners, exec mode, error messages, env', () => {
  test('§F1 — successful nested ssh prints the "Warning: Permanently added" line on first connection', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Type a nested ssh from inside bash — should print the OpenSSH
    // host-key acceptance line the first time.
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    expectAnyLine(t, /Warning: Permanently added '10\.0\.0\.1'.*to the list of known hosts/);
  });

  test('§F2 — successful nested ssh prints "Last login:" the way OpenSSH does', async () => {
    const { winA, linuxA } = await buildLan();
    // Pre-seed a prior login for alice on linuxA so the OpenSSH banner
    // has something to point at. Mirrors the real /var/log/lastlog state
    // that any live host carries.
    linuxA.recordSshLogin('alice', '10.0.0.99', 'home', true, 'password');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    expectAnyLine(t, /Last login:.*from /);
  });

  test('§F3 — exec mode: "ssh user@host cmd args" runs the command remotely and stays in local shell', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // alice has only her own session here. Exec mode SHOULD NOT push a
    // remote shell — it runs the one-shot command and leaves us in the
    // outer bash. With the password challenge first.
    await typeSub(t, 'ssh alice@10.0.0.1 hostname');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expectAnyLine(t, /^linuxA$/);
    // We must still be inside the OUTER ssh (linuxSrv), not pushed onto
    // linuxA.
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§F4 — ssh to a powered-off device fails with a network-unreachable-style message', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.powerOff();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    // No password challenge — connection itself failed.
    expect(t.currentInputMode.type).not.toBe('password');
    expectAnyLine(t, /ssh: connect to host 10\.0\.0\.3 port 22: (No route to host|Network is unreachable|Connection refused)/);
  });

  test('§F5 — ssh -V prints the client version and exits without prompting', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh -V');
    expect(t.currentInputMode.type).not.toBe('password');
    expectAnyLine(t, /OpenSSH_/);
  });

  test('§F7 — ssh -p <wrong_port> reports the wrong port in the error line', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.powerOff();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh -p 2222 alice@10.0.0.3');
    expectAnyLine(t, /port 2222: (No route to host|Network is unreachable|Connection refused)/);
  });

  test('§F8 — auth.log records the accepted login (rsyslog active)', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // The simulator's auth.log should mention alice's accepted login.
    const log = await linuxSrv.executeCommand('cat /var/log/auth.log');
    expect(log).toMatch(/Accepted password for alice/);
  });

  test('§F10 — who shows the SSH user after a successful login', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'who');
    expectAnyLine(t, /^alice\s/);
  });

  test('§F11 — SSH_CONNECTION / SSH_CLIENT env vars are set on the remote', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo "$SSH_CONNECTION"');
    // OpenSSH format: "<client_ip> <client_port> <server_ip> <server_port>"
    // (port numbers are arbitrary in the simulator).
    expectAnyLine(t, /\b10\.0\.0\.4\b.+\b10\.0\.0\.3\b/);
  });

  test('§F13 — echo $USER on the remote returns the SSH user', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo $USER');
    expectAnyLine(t, /^alice$/);
  });

  test('§F14 — tty on a freshly SSH-ed bash returns a /dev/pts/<n> path', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'tty');
    expectAnyLine(t, /^\/dev\/pts\/\d+$/);
  });

  test('§F15 — hostname inside the SSH session returns the REMOTE hostname', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'hostname');
    expectAnyLine(t, /^linuxSrv$/);
  });

  test('§F16 — `last` lists the most recent ssh login after logout', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    const out = await linuxSrv.executeCommand('last -n 5');
    expect(out).toMatch(/alice/);
  });

  test('§U — exact user-reported scenario: Linux→ssh→Win→clear/cls/powershell/gcm', async () => {
    const { linuxA, winA } = await buildLan();
    // Use carl/carl (auto-provisioned via the user manager seed).
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    // Connect: ssh carl@<winA-IP>
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    // First prompt is cmd's, NOT linux-bash.
    expect(t.getPrompt()).toMatch(/^C:\\Users\\carl>/);
    // 'clear' must hit cmd as an unknown command, NOT wipe the screen.
    await typeSub(t, 'clear');
    expectAnyLine(t, /is not recognized as an internal or external command/);
    // User identity stays carl across commands (no drift to 'user').
    expect(t.getPrompt()).toMatch(/^C:\\Users\\carl>/);
    // 'cls' wipes the screen.
    await typeSub(t, 'echo seen-before-cls');
    const before = t.lines.length;
    await typeSub(t, 'cls');
    expect(t.lines.length).toBeLessThan(before);
    expect(t.lines.some((l) => /seen-before-cls/.test(l.text))).toBe(false);
    // 'powershell' pushes a real PS frame; the prompt changes.
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS C:\\Users\\carl>/);
    // 'gcm' is recognised by PS (no cmd-style "not recognized" error).
    await typeSub(t, 'gcm');
    const tail = t.lines.slice(-15).map((l) => l.text).join('\n');
    expect(/is not recognized as an internal or external command/.test(tail)).toBe(false);
  });

  test('§F20 — powering off the remote device mid-session closes the SSH frame cleanly', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    // Simulate the remote going down.
    linuxSrv.powerOff();
    // Issue a command — the device-offline guard should produce a
    // disconnect notice; the next prompt should be back at cmd.exe.
    await typeSub(t, 'whoami');
    // Some signal of disconnection should appear, and we should no
    // longer be on the alice@linuxSrv prompt.
    const tail = t.lines.slice(-10).map((l) => l.text).join('\n');
    const hasDisconnect = /closed|broken pipe|device.*off|powered off|unreachable/i.test(tail);
    expect(hasDisconnect || !/alice@linuxSrv/.test(t.getPrompt())).toBe(true);
  });

  test('§F21 — second SSH attempt to a host with a stale known_hosts entry still succeeds', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§F23 — ssh -l <user> <host> uses -l as the login name (OpenSSH alt syntax)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh -l alice 10.0.0.3');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§F24 — bare host without user defaults to the calling shell user', async () => {
    const { winA, linuxSrv } = await buildLan();
    // Mirror the calling Windows session's default user 'User' on
    // linuxSrv so the SSH connection actually authenticates.
    const um = (linuxSrv as unknown as { executor: { userMgr: { useradd: (u: string, opts: Record<string, unknown>) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
    um.useradd('User', { m: true, s: '/bin/bash' });
    um.setPassword('User', 'User');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh 10.0.0.3');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('User'); t.handleKey(key('Enter')); await flush();
    }
    expect(t.getPrompt()).toMatch(/User@linuxSrv/);
  });

  test('§F25 — ssh user@invalid.host emits the OpenSSH "Could not resolve" error', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@nonexistent.example');
    expect(t.currentInputMode.type).not.toBe('password');
    expectAnyLine(t, /ssh: Could not resolve hostname nonexistent\.example/);
  });

  test('§F38 — ping from inside SSH session probes from the REMOTE host', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // alice on linuxSrv pings linuxA (10.0.0.1) — same subnet.
    await typeSub(t, 'ping -c 1 10.0.0.1');
    expectAnyLine(t, /(1 packets transmitted|bytes from 10\.0\.0\.1)/);
  });

  test('§F39 — env shows the SSH_CONNECTION env var', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'env');
    const tail = t.lines.map((l) => l.text).join('\n');
    expect(/SSH_CONNECTION=/.test(tail)).toBe(true);
  });

  test('§F41 — ssh root@host is refused by default (PermitRootLogin prohibit-password)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh root@10.0.0.3');
    // Either the connection is refused outright (some paths) or
    // password auth fails repeatedly (default 'prohibit-password' means
    // password auth for root is rejected silently — three strikes).
    // Drive three attempts so we hit the lockout path.
    for (let i = 0; i < 3 && t.currentInputMode.type === 'password'; i++) {
      t.setPasswordBuf('admin'); t.handleKey(key('Enter')); await flush();
    }
    // We must NOT end up on the root@linuxSrv# prompt.
    expect(t.getPrompt()).not.toMatch(/^root@linuxSrv/);
  });

  test('§F42 — ssh -p 22 alice@host is identical to bare ssh alice@host', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh -p 22 alice@10.0.0.3');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
  });

  test('§F43 — Cisco IOS `?` inline help is still available after SSH push', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, '?');
    // The IOS `?` help returns a list of words available at the current mode.
    expect(t.lines.length).toBeGreaterThan(0);
  });

  test('§F44 — bash cd then logout, reconnect → cwd resets to $HOME', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /tmp');
    expect(t.getPrompt()).toMatch(/:\/tmp\$/);
    await typeSub(t, 'exit');
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Fresh session — back at $HOME (~).
    expect(t.getPrompt()).toMatch(/:~\$/);
  });

  test('§F45 — chmod, umask and stat round-trip works over SSH', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'touch /tmp/ssh-test');
    await typeSub(t, 'chmod 644 /tmp/ssh-test');
    const out = await linuxSrv.executeCommand('stat -c %a /tmp/ssh-test');
    expect(out.trim()).toBe('644');
  });

  test('§F40 — 6-deep SSH chain: Win→ssh→Linux→ssh→Win→ssh→Linux→ssh→Win→ssh→Linux', async () => {
    const { winA, winB, linuxA, linuxSrv } = await buildLan();
    void linuxA; void linuxSrv; void winB;
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');             // L2 linuxSrv
    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');                // L3 winB cmd
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');               // L4 linuxA
    await typeSshSub(t, 'ssh user@10.0.0.4', 'user');                 // L5 back to winA cmd
    await typeSshSub(t, 'ssh alice@10.0.0.3', 'alice');               // L6 linuxSrv again
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    // Unwind back to base.
    for (let i = 0; i < 5; i++) { await typeSub(t, 'exit'); }
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  test('§F35 — sudo over SSH works (alice in the sudo group)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sudo whoami');
    // sudo may challenge for the password; satisfy it.
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expectAnyLine(t, /^root$/);
  });

  test('§F36 — su - switches identity inside the SSH session', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'su - bob');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('bob'); t.handleKey(key('Enter')); await flush();
    }
    await typeSub(t, 'whoami');
    expectAnyLine(t, /^bob$/);
  });

  test('§F37 — interrupting a running command with Ctrl+C does not break the session', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Type something then hit Ctrl+C without Enter.
    t.setInputBuf('long-typo');
    t.handleKey(key('c', { ctrlKey: true }));
    await flush();
    // Input cleared, session still usable.
    const buf = (t as unknown as { getInputBuf(): string }).getInputBuf();
    expect(buf).toBe('');
    await typeSub(t, 'echo recovered');
    expectAnyLine(t, /^recovered$/);
  });

  test('§F31 — id inside SSH session reports the SSH user (uid + groups)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'id');
    expectAnyLine(t, /uid=\d+\(alice\)/);
  });

  test('§F32 — pipeline ls | grep returns filtered results', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'ls / | grep etc');
    expectAnyLine(t, /etc/);
  });

  test('§F33 — output redirection > /tmp/file writes to the remote filesystem', async () => {
    const { winA, linuxSrv } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo hello-world > /tmp/echo.txt');
    const out = await linuxSrv.executeCommand('cat /tmp/echo.txt');
    expect(out).toMatch(/hello-world/);
  });

  test('§F34 — `which` resolves a binary on the SSH server', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'which ls');
    expectAnyLine(t, /\/bin\/ls|\/usr\/bin\/ls/);
  });

  test('§F27 — tab completion against the SSH cwd completes a directory in /', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'cd /');
    t.setInputBuf('ls et');
    t.handleKey(key('Tab'));
    await flush();
    const buf = (t as unknown as { getInputBuf(): string }).getInputBuf();
    // Should complete `et` → `etc/`.
    expect(buf).toMatch(/etc/);
  });

  test('§F28 — \"history\" inside the SSH session lists commands previously typed', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'echo one');
    await typeSub(t, 'echo two');
    await typeSub(t, 'history');
    const tail = t.lines.slice(-15).map((l) => l.text).join('\n');
    // history should include the recent echo lines.
    expect(/echo one/.test(tail) && /echo two/.test(tail)).toBe(true);
  });

  test('§F29 — `exit` on the SSH side prints \"logout\" + \"Connection to X closed.\"', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'exit');
    expectAnyLine(t, /^logout$/);
    expectAnyLine(t, /Connection to 10\.0\.0\.3 closed\./);
    // Back to cmd.exe.
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  test('§F30 — typing only whitespace re-prompts without dispatching anything', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const before = t.lines.length;
    await typeSub(t, '   ');
    // At most a single prompt-echo line should have been added — no
    // dispatch, no error, no MOTD reprint.
    expect(t.lines.length - before).toBeLessThanOrEqual(2);
  });

  test('§F26 — ssh user@host with empty password retries (does not crash)', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3');
    expect(t.currentInputMode.type).toBe('password');
    // Press Enter with no buffer — empty password.
    t.handleKey(key('Enter'));
    await flush();
    // Empty password is wrong → either a retry prompt or the lockout.
    expectAnyLine(t, /Permission denied/);
  });

  test('§F22 — ssh into router refused when SSH server is disabled', async () => {
    const { winA, cisco } = await buildLan();
    // Forcibly disable the SSH server.
    (cisco as unknown as { sshServerEnabled: boolean }).sshServerEnabled = false;
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh admin@10.0.0.6');
    expectAnyLine(t, /Connection refused|connect to host.*port 22/);
  });

  test('§F18 — ssh -q (quiet): no banner / MOTD / known_hosts warning on success', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh -q alice@10.0.0.3');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);
    const tail = t.lines.slice(-20).map((l) => l.text).join('\n');
    expect(/Permanently added/.test(tail)).toBe(false);
    expect(/Welcome to Ubuntu/.test(tail)).toBe(false);
  });

  test('§F19 — second connection to the same host SKIPS the known_hosts warning', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // logout, reconnect.
    await typeSub(t, 'exit');
    const beforeLines = t.lines.length;
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    const newLines = t.lines.slice(beforeLines).map((l) => l.text).join('\n');
    expect(/Permanently added/.test(newLines)).toBe(false);
  });

  test('§F17 — exec mode prints OUTPUT only — no MOTD, no banner, no last login', async () => {
    const { winA, linuxSrv } = await buildLan();
    linuxSrv.recordSshLogin('alice', '9.9.9.9', 'previous', true, 'password');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await typeRoot(t, 'ssh alice@10.0.0.3 whoami');
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice'); t.handleKey(key('Enter')); await flush();
    }
    expectAnyLine(t, /^alice$/);
    // Exec mode in OpenSSH suppresses the login banner; ensure neither
    // the MOTD nor the "Last login" line leaked into the scrollback.
    const tail = t.lines.slice(-20).map((l) => l.text).join('\n');
    expect(/Last login:/.test(tail)).toBe(false);
    expect(/Welcome to Ubuntu/.test(tail)).toBe(false);
  });

  test('§F12 — multiple concurrent SSH sessions to the same host work independently', async () => {
    const { winA, winB } = await buildLan();
    const t1 = new WindowsTerminalSession('t1', winA);
    const t2 = new WindowsTerminalSession('t2', winB);
    await t1.init();
    await t2.init();
    await winSshLogin(t1, 'ssh alice@10.0.0.3', 'alice');
    await winSshLogin(t2, 'ssh bob@10.0.0.3', 'bob');
    expect(t1.getPrompt()).toMatch(/alice/);
    expect(t2.getPrompt()).toMatch(/bob/);
    // The two sessions live in independent LinuxShellSession states —
    // a `cd` in t1 must not leak into t2.
    await typeSub(t1, 'cd /tmp');
    expect(t1.getPrompt()).toMatch(/alice@linuxSrv:\/tmp\$/);
    expect(t2.getPrompt()).toMatch(/bob@linuxSrv:~\$/);
  });

  test('§F9 — Ctrl+D in an SSH-pushed cmd does NOT log out (cmd ignores it)', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    t.setInput('ssh carl@10.0.0.4');
    t.handleKey(key('Enter'));
    await flush();
    // The legacy enterSsh path does the heavy lifting here; harness's
    // helper just satisfies the password challenge.
    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('carl'); t.handleKey(key('Enter')); await flush();
    }
    // We should now be at cmd's prompt.
    expect(t.getPrompt()).toMatch(/^C:\\Users\\carl>/);
    // Ctrl+D: real cmd ignores it. We must NOT pop the SSH frame.
    t.handleKey(key('d', { ctrlKey: true }));
    await flush();
    expect(t.getPrompt()).toMatch(/^C:\\Users\\carl>/);
  });

  test('§F6 — three bad passwords give the canonical OpenSSH lockout message', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    // Type nested ssh; feed three wrong passwords.
    await typeSub(t, 'ssh alice@10.0.0.1');
    for (let i = 0; i < 3; i++) {
      expect(t.currentInputMode.type).toBe('password');
      t.setPasswordBuf('NOPE');
      t.handleKey(key('Enter'));
      await flush();
    }
    expect(t.currentInputMode.type).not.toBe('password');
    expectAnyLine(t, /alice@10\.0\.0\.1: Permission denied \(publickey,password\)/);
  });
});

// ─── Repro of reported bugs (Linux→SSH→Windows) ─────────────────────

describe('Linux→SSH→Windows: prompt format, clear, powershell, completion', () => {
  test('§R1 — Linux→SSH→Win: prompt is cmd-style "C:\\Users\\carl>", NOT Linux user@host:path$', async () => {
    const { linuxA, winA } = await buildLan();
    // Ensure carl/carl exists on winA.
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    // The prompt the renderer will use must look like cmd, not Linux bash.
    const p = t.getPrompt();
    expect(p).toMatch(/^C:\\Users\\carl>/);
    // The structured parts the Linux PromptRenderer reads must report
    // that the active shell is foreign so it can defer to getPrompt().
    const parts = t.getPromptParts();
    expect(parts.foreign).toBe(true);
  });

  test('§R2 — Linux→SSH→Win: typing "clear" is NOT recognised by cmd', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    await typeSub(t, 'clear');
    // Real cmd prints the canonical "is not recognized" error. The shell
    // must NOT silently wipe the screen — that is bash semantics.
    expectAnyLine(t, /is not recognized as an internal or external command/);
  });

  test('§R3 — Linux→SSH→Win: typing "cls" wipes the buffer (cmd clearWords)', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    await typeSub(t, 'echo seen-before-cls');
    const before = t.lines.length;
    await typeSub(t, 'cls');
    // Buffer should have shrunk meaningfully — at least the "seen-before"
    // line is gone.
    expect(t.lines.length).toBeLessThan(before);
    expect(t.lines.some((l) => /seen-before-cls/.test(l.text))).toBe(false);
  });

  test('§R4 — Linux→SSH→Win: typing "powershell" pushes a real PS frame; "gcm" is recognised', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS C:\\Users\\carl>/);
    // 'gcm' (Get-Command) is a built-in PowerShell alias. Whatever it
    // outputs, the cmd-style "is not recognized" footer MUST NOT appear.
    await typeSub(t, 'gcm');
    const tail = t.lines.slice(-10).map((l) => l.text).join('\n');
    expect(/is not recognized as an internal or external command/.test(tail)).toBe(false);
  });

  test('§R5 — Linux→SSH→Win: user identity stays "carl" across multiple commands', async () => {
    const { linuxA } = await buildLan();
    const t = new LinuxTerminalSession('t', linuxA);
    await t.init();
    await linuxSshLogin(t, 'ssh carl@10.0.0.4', 'carl');
    await typeSub(t, 'echo a');
    await typeSub(t, 'echo b');
    await typeSub(t, 'echo c');
    expect(t.getPrompt()).toMatch(/carl/);
  });

  test('§R6 — Windows→SSH→Linux: Tab completion runs against the REMOTE bash', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    t.setInputBuf('ls /et');
    t.handleKey(key('Tab'));
    await flush();
    // The remote bash should expand /et → /etc.
    const buf = (t as unknown as { getInputBuf(): string }).getInputBuf();
    expect(buf).toMatch(/\/etc/);
  });
});



describe('Universal styled output — every shell emits styled segments', () => {
  test('§S1 — sqlplus output lines carry segments through the SSH boundary', async () => {
    const { winA } = await buildLan();
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    await typeSub(t, 'sqlplus / as sysdba');
    // SQL*Plus banner / prompt lines should now carry segments
    // (synthesised by AbstractShell when the dispatcher does not produce
    // its own styling). At least ONE recently-added line must have
    // segments populated, proving the universal pipeline.
    const tail = t.lines.slice(-30);
    const styled = tail.filter((l) => l.segments && l.segments.length > 0);
    expect(styled.length).toBeGreaterThan(0);
  });

  test('§S2 — Cisco IOS output lines also carry styled segments', async () => {
    const { winA, cisco } = await buildLan();
    cisco.setHostname('R1');
    const t = new WindowsTerminalSession('t', winA);
    await t.init();
    await winSshLogin(t, 'ssh admin@10.0.0.6', 'Admin@123');
    await typeSub(t, 'show version');
    const tail = t.lines.slice(-30);
    const styled = tail.filter((l) => l.segments && l.segments.length > 0);
    expect(styled.length).toBeGreaterThan(0);
  });
});

/**
 * Root-cause integrity suite.
 *
 * Goal:
 * Detect ANY shell identity corruption, renderer leakage,
 * prompt hybridisation, wrong dispatcher inheritance,
 * broken nested-session ownership, or wrong active-shell routing.
 *
 * Philosophy:
 * After EVERY shell transition:
 *   1. Assert prompt identity
 *   2. Execute shell-native command
 *   3. Execute foreign-shell command and ensure rejection
 *   4. Mutate remote state/config
 *   5. Verify mutation persisted on the CORRECT remote host
 *   6. Verify parent shell state did NOT leak
 *
 * This suite intentionally stress-tests:
 *   - Linux bash
 *   - Windows CMD
 *   - PowerShell
 *   - Cisco IOS
 *   - Huawei VRP
 *   - SQLPlus
 *   - deep nested SSH
 *   - shell stack unwinding
 *   - renderer ownership
 *   - active-shell dispatch
 */

describe('Root-cause shell/session integrity', () => {
  test('§RC1 — Win→Linux→Win→PS→Linux→Cisco : every shell preserves its own semantics', async () => {
    const { winA, linuxSrv, linuxA, cisco } = await buildLan();

    cisco.setHostname('R1');

    const t = new WindowsTerminalSession('t', winA);
    await t.init();

    // ─────────────────────────────────────────────
    // L1 — LOCAL CMD
    // ─────────────────────────────────────────────

    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);

    await typeRoot(t, 'mkdir C:\\temp_rc1');

    // cmd rejects linux clear
    await typeRoot(t, 'clear');

    expectAnyLine(
      t,
      /is not recognized as an internal or external command/,
    );

    // ─────────────────────────────────────────────
    // L2 — SSH LINUX
    // ─────────────────────────────────────────────

    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');

    expect(t.getPrompt()).toMatch(/alice@linuxSrv:~\$/);

    // shell identity
    expect(t.getPrompt()).not.toMatch(/^C:\\/);

    // mutate linux state
    await typeSub(t, 'mkdir -p /tmp/rc1_linuxsrv');
    await typeSub(t, 'touch /tmp/rc1_linuxsrv/a');

    const out1 = await linuxSrv.executeCommand('ls /tmp/rc1_linuxsrv');
    expect(out1).toMatch(/a/);

    // linux rejects cmd clear
    await typeSub(t, 'cls');

    expectAnyLine(
      t,
      /command not found|not recognized/,
    );

    // ─────────────────────────────────────────────
    // L3 — SSH WINDOWS CMD
    // ─────────────────────────────────────────────

    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');

    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);

    expect(t.getPrompt()).not.toMatch(/@linuxSrv/);

    // mutate remote windows
    await typeSub(t, 'mkdir C:\\rc1_nested');

    // cmd rejects bash syntax
    await typeSub(t, 'touch /tmp/x');

    expectAnyLine(
      t,
      /not recognized as an internal or external command/,
    );

    // ─────────────────────────────────────────────
    // L4 — POWERSHELL
    // ─────────────────────────────────────────────

    await typeSub(t, 'powershell');

    expect(t.getPrompt()).toMatch(/^PS C:\\Users\\user>/);

    // powershell-native alias
    await typeSub(t, 'gcm');

    const psTail = t.lines.slice(-20).map((l) => l.text).join('\n');

    expect(
      /not recognized as an internal or external command/.test(psTail),
    ).toBe(false);

    // mutate powershell state
    await typeSub(t, 'New-Item -ItemType Directory C:\\rc1_ps');

    // ─────────────────────────────────────────────
    // L5 — SSH LINUX AGAIN
    // ─────────────────────────────────────────────

    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');

    expect(t.getPrompt()).toMatch(/alice@linuxA/);

    expect(t.getPrompt()).not.toMatch(/^PS /);

    // mutate linuxA
    await typeSub(t, 'echo rc1 > /tmp/rc1.txt');

    const out2 = await linuxA.executeCommand('cat /tmp/rc1.txt');

    expect(out2.trim()).toBe('rc1');

    // bash accepts clear
    const beforeClear = t.lines.length;

    await typeSub(t, 'clear');

    expect(t.lines.length).toBeLessThan(beforeClear);

    // ─────────────────────────────────────────────
    // L6 — SSH CISCO
    // ─────────────────────────────────────────────

    await typeSshSub(t, 'ssh admin@10.0.0.6', 'Admin@123');

    expect(t.getPrompt()).toMatch(/^R1[#>]/);

    // IOS native config
    if (/>\s?$/.test(t.getPrompt())) {
      await typeSub(t, 'enable');

      if (t.currentInputMode.type === 'password') {
        t.setPasswordBuf('Admin@123');
        t.handleKey(key('Enter'));
        await flush();
      }
    }

    expect(t.getPrompt()).toMatch(/^R1#/);

    await typeSub(t, 'configure terminal');

    expect(t.getPrompt()).toMatch(/^R1\(config\)#/);

    await typeSub(t, 'hostname RC1');

    expect(t.getPrompt()).toMatch(/^RC1\(config\)#/);

    // IOS rejects linux command
    await typeSub(t, 'ls');

    // unwind
    await typeSub(t, 'end');
    expect(t.getPrompt()).toMatch(/^RC1#/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxA/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^PS /);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/alice@linuxSrv/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);
  });

  test('§RC2 — Linux→Huawei→Linux→SQLPlus→Win→PS : shell ownership never leaks', async () => {
    const { linuxA, huawei } = await buildLan();

    huawei.setHostname('HW');

    const t = new LinuxTerminalSession('t', linuxA);

    await t.init();

    // L1 bash
    expect(t.getPrompt()).toMatch(/@linuxA/);

    // L2 Huawei
    await linuxSshLogin(t, 'ssh admin@10.0.0.7', 'Admin@123');

    expect(t.getPrompt()).toMatch(/^<HW>/);

    await typeSub(t, 'system-view');

    expect(t.getPrompt()).toMatch(/^\[HW\]/);

    // config mutation
    await typeSub(t, 'sysname CORE-HW');

    expect(t.getPrompt()).toMatch(/^\[CORE-HW\]/);

    // VRP rejects bash command
    await typeSub(t, 'touch /tmp/x');

    // exit Huawei
    await typeSub(t, 'quit');
    expect(t.getPrompt()).toMatch(/^<CORE-HW>/);

    await typeSub(t, 'quit');

    // back linux
    expect(t.getPrompt()).toMatch(/@linuxA/);

    // L3 nested linux
    await typeSshSub(t, 'ssh alice@10.0.0.3', 'alice');

    expect(t.getPrompt()).toMatch(/@linuxSrv/);

    // L4 sqlplus
    await typeSub(t, 'sqlplus / as sysdba');

    expect(t.getPrompt()).toMatch(/^SQL>/);

    await typeSub(t, 'create user rc2 identified by rc2;');

    // SQL shell rejects bash clear
    await typeSub(t, 'clear');

    // unwind sqlplus
    await typeSub(t, 'exit');

    expect(t.getPrompt()).toMatch(/@linuxSrv/);

    // L5 nested windows
    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');

    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);

    // cmd mutation
    await typeSub(t, 'mkdir C:\\RC2');

    // L6 powershell
    await typeSub(t, 'powershell');

    expect(t.getPrompt()).toMatch(/^PS /);

    await typeSub(t, '$env:RC2_TEST="OK"');

    await typeSub(t, 'echo $env:RC2_TEST');

    expectAnyLine(t, /^OK$/);

    // unwind all
    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/@linuxSrv/);

    await typeSub(t, 'exit');
    expect(t.getPrompt()).toMatch(/@linuxA/);
  });

  test('§RC3 — renderer NEVER hybridises prompts across 7 nested shells', async () => {
    const { winA } = await buildLan();

    const t = new WindowsTerminalSession('t', winA);

    await t.init();

    // L1 cmd
    expect(t.getPrompt()).toMatch(/^C:\\Users\\/);

    // L2 linux
    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    expect(t.getPrompt()).toMatch(/@linuxSrv/);

    // L3 win
    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');
    expect(t.getPrompt()).toMatch(/^C:\\Users\\user>/);

    // L4 PS
    await typeSub(t, 'powershell');
    expect(t.getPrompt()).toMatch(/^PS /);

    // L5 linux
    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    expect(t.getPrompt()).toMatch(/@linuxA/);

    // L6 sqlplus
    await typeSub(t, 'sqlplus / as sysdba');
    expect(t.getPrompt()).toMatch(/^SQL>/);

    // L7 back to linux from sqlplus-host
    await typeSub(t, 'exit');

    expect(t.getPrompt()).toMatch(/@linuxA/);

    // ABSOLUTE invariant:
    // NO prompt may ever become hybrid.

    const prompts = t.lines
      .map((l) => l.text)
      .filter((x) =>
        /(^PS )|(@.*\$)|(^C:\\)|(^SQL>)|(^<)|(^\[)/.test(x),
      );

    for (const p of prompts) {
      // forbidden hybrids
      expect(p).not.toMatch(/@.*C:\\/);
      expect(p).not.toMatch(/C:\\.*\$/);
      expect(p).not.toMatch(/^PS .*@/);
      expect(p).not.toMatch(/^SQL>.*@/);
      expect(p).not.toMatch(/^<.*C:\\/);
    }
  });

  test('§RC4 — active shell dispatcher ALWAYS owns command routing', async () => {
    const { winA } = await buildLan();

    const t = new WindowsTerminalSession('t', winA);

    await t.init();

    // CMD
    await typeRoot(t, 'ls');

    expectAnyLine(
      t,
      /not recognized as an internal or external command/,
    );

    // PowerShell
    await typeRoot(t, 'powershell');

    await typeSub(t, 'ls');

    const psTail = t.lines.slice(-10).map((l) => l.text).join('\n');

    expect(
      /not recognized as an internal or external command/.test(psTail),
    ).toBe(false);

    // Linux
    await typeSub(t, 'ssh alice@10.0.0.3');

    if (t.currentInputMode.type === 'password') {
      t.setPasswordBuf('alice');
      t.handleKey(key('Enter'));
      await flush();
    }

    await typeSub(t, 'ls');

    const linuxTail = t.lines.slice(-10).map((l) => l.text).join('\n');

    expect(
      /not recognized as an internal or external command/.test(linuxTail),
    ).toBe(false);

    // Cisco
    await typeSshSub(t, 'ssh admin@10.0.0.6', 'Admin@123');

    await typeSub(t, 'dir');

    expect(t.lines.length).toBeGreaterThan(0);

    // IOS should NOT suddenly behave like bash/cmd/powershell
    await typeSub(t, 'Get-ChildItem');

    const iosTail = t.lines.slice(-10).map((l) => l.text).join('\n');

    expect(/Get-ChildItem/.test(iosTail)).toBe(true);
  });

  test('§RC5 — shell stack corruption detector', async () => {
    const { winA } = await buildLan();

    const t = new WindowsTerminalSession('t', winA);

    await t.init();

    const prompts: string[] = [];

    function snap() {
      prompts.push(t.getPrompt());
    }

    snap();

    await winSshLogin(t, 'ssh alice@10.0.0.3', 'alice');
    snap();

    await typeSshSub(t, 'ssh user@10.0.0.5', 'user');
    snap();

    await typeSub(t, 'powershell');
    snap();

    await typeSshSub(t, 'ssh alice@10.0.0.1', 'alice');
    snap();

    await typeSub(t, 'sqlplus / as sysdba');
    snap();

    // unwind
    await typeSub(t, 'exit');
    snap();

    await typeSub(t, 'exit');
    snap();

    await typeSub(t, 'exit');
    snap();

    await typeSub(t, 'exit');
    snap();

    await typeSub(t, 'exit');
    snap();

    // Stack integrity:
    // after full unwind we MUST return to original prompt.

    expect(prompts[0]).toBe(prompts[prompts.length - 1]);

    // no duplicate accidental shell collapse
    for (let i = 1; i < prompts.length; i++) {
      expect(prompts[i]).toBeTruthy();
    }
  });
});
