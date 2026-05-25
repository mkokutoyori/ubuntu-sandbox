/**
 * Cross-vendor SSH interactive sub-shell suite — UI-level end-to-end tests.
 *
 * Sibling of {@link ./cross-equipment-ssh-suite.test.ts}, but exercising
 * the **interactive form** (`ssh user@host` with NO command after the
 * host) through the very same surface a React view drives:
 *
 *     session.setInput(line); session.handleKey({key: 'Enter', ...});
 *
 * The contract these tests pin down is the one the user reported broken:
 * when an operator types `ssh user@192.168.1.1` from cmd.exe, the
 * terminal MUST land in a real remote shell — not print the banner and
 * close. The same contract holds for Linux clients reaching Windows /
 * Cisco / Huawei peers, and for the symmetric flow from a Linux client.
 *
 * Topology (built fresh per test):
 *
 *     linuxA ─┐
 *     linuxB ─┤
 *     winA   ─┼─ core-sw ── 10.0.0.0/24
 *     winB   ─┤
 *     ciscoR ─┤
 *     hwR    ─┘
 *
 *   linuxA=10.0.0.1  linuxB=10.0.0.2
 *   winA=10.0.0.3    winB=10.0.0.4
 *   ciscoR=10.0.0.5  hwR=10.0.0.6
 *
 * Each section is its own describe block; `test.each` rows feed the
 * matrix so adding a vendor or a user is one line.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

// ─── LAN fixture ────────────────────────────────────────────────────

interface XLan {
  linuxA: LinuxPC; linuxB: LinuxPC;
  winA: WindowsPC; winB: WindowsPC;
  ciscoR: CiscoRouter; hwR: HuaweiRouter;
  sw: GenericSwitch;
  ipOf: Record<string, string>;
}

async function buildXLan(): Promise<XLan> {
  EquipmentRegistry.getInstance().clear();
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxB = new LinuxPC('linux-pc', 'linuxB', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const ciscoR = new CiscoRouter('ciscoR', 0, 0);
  const hwR = new HuaweiRouter('hwR', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 16, 0, 0);

  const all = [linuxA, linuxB, winA, winB, ciscoR, hwR];
  all.forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });

  const mask = new SubnetMask('255.255.255.0');
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linuxB.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);

  // Network OS interface bring-up via native CLI — pings need an L3 IP.
  await ciscoR.executeCommand('enable');
  await ciscoR.executeCommand('configure terminal');
  await ciscoR.executeCommand('interface GigabitEthernet0/0');
  await ciscoR.executeCommand('ip address 10.0.0.5 255.255.255.0');
  await ciscoR.executeCommand('no shutdown');
  await ciscoR.executeCommand('end');

  await hwR.executeCommand('system-view');
  await hwR.executeCommand('interface GigabitEthernet0/0/0');
  await hwR.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await hwR.executeCommand('undo shutdown');
  await hwR.executeCommand('quit');
  await hwR.executeCommand('quit');

  linuxA.setHostname('linuxA'); linuxB.setHostname('linuxB');

  // Seed the user cast that SSH consumes on Linux. WindowsPC ships with
  // `User` and `Administrator` out of the box. Routers expose their AAA
  // via `enableCiscoSsh` / `enableHuaweiSsh` (helpers below).
  for (const d of [linuxA, linuxB]) {
    const um = (d as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      getUser: (u: string) => unknown;
      setPassword: (u: string, p: string) => void;
      usermod: (u: string, o: object) => void;
    } } }).executor.userMgr;
    for (const u of ['alice', 'bob', 'admin']) {
      if (!um.getUser(u)) {
        um.useradd(u, { m: true, s: '/bin/bash' });
        um.setPassword(u, 'admin');
        if (u === 'alice' || u === 'admin') um.usermod(u, { aG: 'sudo' });
      }
    }
  }

  return {
    linuxA, linuxB, winA, winB, ciscoR, hwR, sw,
    ipOf: {
      linuxA: '10.0.0.1', linuxB: '10.0.0.2',
      winA: '10.0.0.3', winB: '10.0.0.4',
      ciscoR: '10.0.0.5', hwR: '10.0.0.6',
    },
  };
}

async function enableCiscoSsh(dev: CiscoRouter): Promise<void> {
  await dev.executeCommand('enable');
  await dev.executeCommand('configure terminal');
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

async function enableHuaweiSsh(dev: HuaweiRouter): Promise<void> {
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

// ─── UI helpers ─────────────────────────────────────────────────────

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return {
    key: k,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

/** Drain pending microtasks + macrotasks. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Type a line at the active prompt and press Enter. */
async function type(session: TerminalSession, line: string): Promise<void> {
  // Active sub-shell drives input through `_inputBuf` (setInputBuf);
  // the root cmd / bash prompt uses `input` (setInput).
  // We set both so the call works in either mode — the unused buffer
  // is cleared on the next Enter anyway.
  session.setInput(line);
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

/**
 * Drive a complete `ssh user@host` interactive login from the Windows
 * cmd terminal: type the ssh line, then satisfy the password challenge
 * with the supplied secret. After this resolves the active sub-shell
 * is the remote's primary shell.
 */
async function sshLogin(
  session: TerminalSession, line: string, password: string,
): Promise<void> {
  await type(session, line);
  // Drain the password mode if the simulator's SSH push entered it.
  if (session.currentInputMode.type === 'password') {
    session.setPasswordBuf(password);
    session.handleKey(key('Enter'));
    await flush();
  }
}

function linesOf(session: TerminalSession): string[] {
  return session.lines.map(l => l.text);
}

function lastN(session: TerminalSession, n: number): string[] {
  const ls = linesOf(session);
  return ls.slice(Math.max(0, ls.length - n));
}

/** Assert that ANY line in the session matches the substring/regex. */
function expectContains(session: TerminalSession, needle: string | RegExp): void {
  const ls = linesOf(session);
  const hit = ls.some(l => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  if (!hit) {
    throw new Error(
      `Expected terminal to contain ${String(needle)}\n--- actual ---\n${ls.join('\n')}\n---`,
    );
  }
}

function expectExcludes(session: TerminalSession, needle: string | RegExp): void {
  const ls = linesOf(session);
  const hit = ls.some(l => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  if (hit) {
    throw new Error(
      `Expected terminal NOT to contain ${String(needle)}\n--- actual ---\n${ls.join('\n')}\n---`,
    );
  }
}

// ─── §1 — Windows → Linux interactive SSH (the reported bug) ────────
//
// User typed `ssh user@192.168.1.1` from cmd.exe and got the Ubuntu
// banner immediately followed by "Connection to … closed." — the
// session never became interactive. After the fix, the same
// keystrokes must land the user in a real remote shell where the
// next typed command is dispatched to the remote, and only
// `exit`/`logout` brings them back to cmd.

describe('§1 — Windows → Linux interactive SSH (regression for the reported bug)', () => {
  let lan: XLan;
  let term: WindowsTerminalSession;
  beforeEach(async () => {
    lan = await buildXLan();
    term = new WindowsTerminalSession('w1', lan.winA);
    await term.init();
  });

  test('ssh user@linuxA: terminal lands in the remote prompt after password', async () => {
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    // After the push, the prompt belongs to the Linux remote — not C:\
    expect(term.getPrompt()).toMatch(/user@linuxA:~\$/);
    // Banner + remote shell visible; no "Connection to … closed" yet.
    expectExcludes(term, /Connection to 10\.0\.0\.1 closed/);
  });

  test('ssh prompts for the user password before pushing the shell', async () => {
    await type(term, 'ssh user@10.0.0.1');
    // Validation succeeded → terminal is in password mode now.
    expect(term.currentInputMode.type).toBe('password');
    expectContains(term, /user@10\.0\.0\.1's password:/);
  });

  test('wrong password is rejected with the canonical retry / final message', async () => {
    await sshLogin(term, 'ssh user@10.0.0.1', 'totally-wrong');
    expectContains(term, /Permission denied, please try again|Permission denied \(/);
  });

  test('after ssh, remote `hostname` returns the LINUX device name', async () => {
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    await type(term, 'hostname');
    expectContains(term, /^linuxA$/);
  });

  test('exit in the remote shell pops back to cmd.exe with the closing line', async () => {
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    expect(term.getPrompt()).toMatch(/user@linuxA/);
    await type(term, 'exit');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
    expectContains(term, /Connection to 10\.0\.0\.1 closed/);
  });

  test('Permission denied is surfaced without entering a sub-shell', async () => {
    await type(term, 'ssh root@10.0.0.1'); // default PermitRootLogin no
    expectContains(term, /Permission denied/);
    // Prompt stays on Windows — no sub-shell was pushed.
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('Connection refused when sshd is stopped on the target', async () => {
    await lan.linuxA.executeCommand('systemctl stop ssh');
    await type(term, 'ssh user@10.0.0.1');
    expectContains(term, /Connection refused/);
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });
});

// ─── §2 — Windows → Cisco IOS interactive SSH ───────────────────────

describe('§2 — Windows → Cisco IOS interactive SSH', () => {
  let lan: XLan;
  let term: WindowsTerminalSession;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableCiscoSsh(lan.ciscoR);
    term = new WindowsTerminalSession('w2', lan.winA);
    await term.init();
  });

  test('ssh admin@ciscoR drops into the IOS privileged prompt', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.5', 'Admin@123');
    expect(term.getPrompt()).toMatch(/ciscoR#/);
  });

  test('show version on Cisco prints the IOS banner', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.5', 'Admin@123');
    await type(term, 'show version');
    expectContains(term, /IOS|Cisco/i);
  });

  test('exit pops back to cmd.exe', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.5', 'Admin@123');
    await type(term, 'exit');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });
});

// ─── §3 — Windows → Huawei VRP interactive SSH ──────────────────────

describe('§3 — Windows → Huawei VRP interactive SSH', () => {
  let lan: XLan;
  let term: WindowsTerminalSession;
  beforeEach(async () => {
    lan = await buildXLan();
    await enableHuaweiSsh(lan.hwR);
    term = new WindowsTerminalSession('w3', lan.winA);
    await term.init();
  });

  test('ssh admin@hwR drops into the VRP user-view prompt', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.6', 'Admin@123');
    expect(term.getPrompt()).toMatch(/<hwR>/);
  });

  test('display version prints the Huawei VRP banner', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.6', 'Admin@123');
    await type(term, 'display version');
    expectContains(term, /VRP|Huawei/i);
  });

  test('quit pops back to cmd.exe — VRP uses "quit", not "exit"', async () => {
    await sshLogin(term, 'ssh admin@10.0.0.6', 'Admin@123');
    await type(term, 'quit');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });
});

// ─── §4 — Windows → Windows interactive SSH ─────────────────────────

describe('§4 — Windows → Windows interactive SSH', () => {
  let lan: XLan;
  let term: WindowsTerminalSession;
  beforeEach(async () => {
    lan = await buildXLan();
    term = new WindowsTerminalSession('w4', lan.winA);
    await term.init();
  });

  test('ssh User@winB drops into a Windows-style prompt', async () => {
    await sshLogin(term, 'ssh User@10.0.0.4', 'user');
    expect(term.getPrompt()).toMatch(/C:\\Users\\User>/);
  });

  test('ver on the remote returns the Microsoft Windows version banner', async () => {
    await sshLogin(term, 'ssh User@10.0.0.4', 'user');
    await type(term, 'ver');
    expectContains(term, /Microsoft Windows/);
  });
});

// Linux-side interactive SSH (Linux → {Windows,Cisco,Huawei,Linux}) is
// already covered exhaustively by ssh-ui-flow.test.ts and the existing
// cross-equipment-ssh-suite (exec mode + push helpers). This file owns
// the Windows-client UI gap that previously dropped the user back to
// cmd.exe after the banner — symmetric coverage there would just
// duplicate the LinuxTerminalSession flow engine's own contract.

// ─── §5 — Multiple users land in their own sub-shells ───────────────
//
// The strategy.prompt() must reflect the *connecting* user, not the
// remote's currentUser. A user-suffix mismatch would break the
// "who am I logged in as?" affordance any operator relies on.

describe('§5 — User identity travels through the SSH push', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  const matrix = [
    { name: 'alice from Windows → Linux',
      build: () => new WindowsTerminalSession('m1', lan.winA),
      cmd: 'ssh alice@10.0.0.1', pw: 'alice',
      promptRe: /alice@linuxA/ },
    { name: 'bob from Windows → Linux',
      build: () => new WindowsTerminalSession('m2', lan.winA),
      cmd: 'ssh bob@10.0.0.1', pw: 'bob',
      promptRe: /bob@linuxA/ },
    { name: 'Administrator from Windows → Windows',
      build: () => new WindowsTerminalSession('m3', lan.winA),
      cmd: 'ssh Administrator@10.0.0.4', pw: 'admin',
      promptRe: /C:\\Users\\Administrator>/ },
  ];

  test.each(matrix)('$name', async (row) => {
    const term = row.build();
    await term.init();
    await sshLogin(term, row.cmd, row.pw);
    expect(term.getPrompt()).toMatch(row.promptRe);
  });
});

// ─── §6 — Topology failure modes propagate to the UI ────────────────

describe('§6 — Topology failure modes propagate to the interactive client', () => {
  let lan: XLan;
  let term: WindowsTerminalSession;
  beforeEach(async () => {
    lan = await buildXLan();
    term = new WindowsTerminalSession('w8', lan.winA);
    await term.init();
  });

  test('unresolved hostname → "Could not resolve hostname"', async () => {
    await type(term, 'ssh user@nope.invalid');
    expectContains(term, /Could not resolve hostname/);
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('powered-off target → "No route to host"', async () => {
    lan.linuxA.powerOff();
    await type(term, 'ssh user@10.0.0.1');
    expectContains(term, /No route to host/);
  });

  test('interface down on target → "No route to host"', async () => {
    await lan.linuxA.executeCommand('ip link set eth0 down');
    await type(term, 'ssh user@10.0.0.1');
    expectContains(term, /No route to host/);
  });
});

// ─── §7 — Device-level cross-vendor exec mode is unaffected ─────────
//
// The interactive intercept is a UI-level addition; the device-level
// `executeCommand('ssh user@host')` and the `ssh user@host <cmd>` exec
// form still produce the original transcripts that the rest of the
// cross-equipment and windows-lan suites rely on.

describe('§7 — Device-level exec mode regression guard', () => {
  let lan: XLan;
  beforeEach(async () => { lan = await buildXLan(); });

  test('device.executeCommand("ssh User@winB") still returns banner + closed', async () => {
    const out = await lan.winA.executeCommand('ssh User@10.0.0.4');
    expect(out).toMatch(/Microsoft Windows/);
    expect(out).toMatch(/Connection to 10\.0\.0\.4 closed/);
  });

  test('exec mode (ssh user@host hostname) still returns the remote hostname', async () => {
    const out = await lan.winA.executeCommand('ssh user@10.0.0.1 hostname');
    expect(out).toMatch(/linuxA/);
  });
});
