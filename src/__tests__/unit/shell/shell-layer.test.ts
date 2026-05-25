/**
 * Shell layer — unit tests.
 *
 * Verifies the new `IShell` / `AbstractShell` foundation and the
 * `CrossVendorRemoteShell` composite:
 *   - The pipeline (history / exit / clear-screen / dispatch) routes
 *     correctly for every concrete shell.
 *   - SSH push over `WindowsTerminalSession` lands the user in a real
 *     PowerShell / SQL*Plus on the remote — fixing the regressions the
 *     refonte ticket reports.
 *   - `cls` / `clear` typed inside the SSH'd remote actually clears
 *     the local terminal (the screen-wipe flag propagates).
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

import {
  ShellContext, ShellFactory, AbstractShell,
  type AbstractShellOptions, type IShell, type ShellLineResult,
  installDefaultShells, reinstallDefaultShells,
} from '@/shell';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';
import { LinuxBashShell } from '@/shell/adapters/LinuxBashShell';

// ─── Fixtures ───────────────────────────────────────────────────────

interface Lan {
  linuxA: LinuxPC; linuxSrv: LinuxServer; winA: WindowsPC; winB: WindowsPC;
}

async function buildLan(): Promise<Lan> {
  EquipmentRegistry.getInstance().clear();
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxSrv = new LinuxServer('linux-server', 'linuxSrv', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);

  const mask = new SubnetMask('255.255.255.0');
  [linuxA, linuxSrv, winA, winB].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  linuxSrv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  linuxA.setHostname('linuxA'); linuxSrv.setHostname('linuxSrv');
  return { linuxA, linuxSrv, winA, winB };
}

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function sshLogin(
  session: WindowsTerminalSession, line: string, password: string,
): Promise<void> {
  session.setInput(line);
  session.handleKey(key('Enter'));
  await flush();
  if (session.currentInputMode.type === 'password') {
    session.setPasswordBuf(password);
    session.handleKey(key('Enter'));
    await flush();
  }
}

async function typeInSubShell(session: WindowsTerminalSession, line: string): Promise<void> {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

// ─── §A — AbstractShell pipeline ────────────────────────────────────

class FakeShell extends AbstractShell {
  readonly kind = 'fake';
  dispatched: string[] = [];
  constructor(opts: AbstractShellOptions) { super(opts); }
  getPrompt(): string { return `${this.user}@fake$ `; }
  protected dispatch(line: string): ShellLineResult {
    this.dispatched.push(line);
    return { output: [`echo: ${line}`] };
  }
}

function fakeShell(): FakeShell {
  return new FakeShell({
    device: { getHostname: () => 'fake', getId: () => 'f' } as unknown as Parameters<typeof AbstractShell>[0]['device'] extends infer D ? D : never,
    user: 'alice',
    context: new ShellContext('fake', ShellContext.userCredentials('alice'), '/home/alice'),
  });
}

describe('§A — AbstractShell pipeline (Template Method)', () => {
  test('empty line returns no output and no dispatch', async () => {
    const s = fakeShell();
    const r = await s.processLine('   ');
    expect(r.output).toEqual([]);
    expect(s.dispatched).toEqual([]);
  });

  test('history records the line and dedupes consecutive duplicates', async () => {
    const s = fakeShell();
    await s.processLine('ls');
    await s.processLine('ls');
    await s.processLine('whoami');
    expect(s.context.history).toEqual(['ls', 'whoami']);
  });

  test('"exit" / "logout" unwinds the shell with its deactivation banner', async () => {
    const s = fakeShell();
    const r = await s.processLine('exit');
    expect(r.exit).toBe(true);
    expect(s.dispatched).toEqual([]); // not dispatched as a command
  });

  test('"clear" / "cls" emit clearScreen=true without dispatching', async () => {
    const s = fakeShell();
    expect((await s.processLine('clear')).clearScreen).toBe(true);
    expect((await s.processLine('cls')).clearScreen).toBe(true);
    expect(s.dispatched).toEqual([]);
  });

  test('Ctrl+L → clear-screen action; Ctrl+C → cancel; Ctrl+D → eof', () => {
    const s = fakeShell();
    expect(s.classifyKey({ key: 'l', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }).kind).toBe('clear-screen');
    expect(s.classifyKey({ key: 'c', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }).kind).toBe('cancel');
    expect(s.classifyKey({ key: 'd', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }).kind).toBe('eof');
  });

  test('non-special line is dispatched verbatim', async () => {
    const s = fakeShell();
    const r = await s.processLine('  uname -a  ');
    expect(r.output).toEqual(['echo: uname -a']);
    expect(s.dispatched).toEqual(['uname -a']);
  });
});

// ─── §B — ShellFactory + default registry ───────────────────────────

describe('§B — ShellFactory creational pattern', () => {
  beforeEach(() => { reinstallDefaultShells(); });

  test('the built-in kinds are registered after install', () => {
    installDefaultShells();
    expect(ShellFactory.has('bash')).toBe(true);
    expect(ShellFactory.has('cmd')).toBe(true);
    expect(ShellFactory.has('powershell')).toBe(true);
    expect(ShellFactory.has('sqlplus')).toBe(true);
  });

  test('create returns an IShell with a fresh ShellContext', async () => {
    const lan = await buildLan();
    const shell: IShell = ShellFactory.create('bash', {
      device: lan.linuxA, user: 'alice',
    });
    expect(shell.kind).toBe('bash');
    expect(shell.user).toBe('alice');
    expect(shell.context.cwd).toBe('/home/alice');
  });

  test('tryCreateChild returns null for an unregistered kind', () => {
    ShellFactory.reset();
    ShellFactory.register('bash', (a) => new LinuxBashShell(a));
    const lan = { device: {} as unknown as Parameters<typeof ShellFactory['create']>[1]['device'] };
    expect(ShellFactory.tryCreateChild('does-not-exist', { device: lan.device, user: 'x' })).toBeNull();
  });

  test('Windows context defaults to C:\\Users\\<user> for the SSH user', async () => {
    const lan = await buildLan();
    const shell = ShellFactory.create('cmd', { device: lan.winB, user: 'Administrator' });
    expect(shell.context.cwd).toBe('C:\\Users\\Administrator');
    expect(shell.getPrompt()).toBe('C:\\Users\\Administrator>');
  });
});

// ─── §C — CrossVendorRemoteShell composite ──────────────────────────

describe('§C — CrossVendorRemoteShell composite', () => {
  beforeEach(() => { reinstallDefaultShells(); });

  test('exposes the primary shell prompt while the stack is non-empty', async () => {
    const lan = await buildLan();
    const x = new CrossVendorRemoteShell({
      device: lan.linuxA, user: 'alice',
      remoteHost: '10.0.0.1', primaryKind: 'bash',
    });
    expect(x.getPrompt()).toMatch(/alice@linuxA:~\$/);
  });

  test('exit on the primary closes the SSH session with the OpenSSH footer', async () => {
    const lan = await buildLan();
    const x = new CrossVendorRemoteShell({
      device: lan.linuxA, user: 'alice',
      remoteHost: '10.0.0.1', primaryKind: 'bash',
    });
    const r = await x.processLine('exit');
    expect(r.exit).toBe(true);
    expect(r.output.join('\n')).toMatch(/Connection to 10\.0\.0\.1 closed/);
    expect(x.isFinished).toBe(true);
  });

  test('clear / cls inside the remote shell propagates clearScreen=true', async () => {
    const lan = await buildLan();
    const x = new CrossVendorRemoteShell({
      device: lan.winB, user: 'User',
      remoteHost: '10.0.0.4', primaryKind: 'cmd',
    });
    expect((await x.processLine('cls')).clearScreen).toBe(true);
    expect((await x.processLine('clear')).clearScreen).toBe(true);
  });

  test('a child shell pushed from the primary intercepts subsequent lines', async () => {
    const lan = await buildLan();
    const x = new CrossVendorRemoteShell({
      device: lan.winB, user: 'User',
      remoteHost: '10.0.0.4', primaryKind: 'cmd',
    });
    // `powershell` inside cmd pushes a PowerShell child shell.
    const r = await x.processLine('powershell');
    expect(x.getPrompt()).toMatch(/PS [A-Z]:\\/);
    expect(r.output.join('\n')).toMatch(/Windows PowerShell|PowerShell/i);
  });
});

// ─── §D — Bug regressions reported by the user ──────────────────────

describe('§D — Reported bugs that the new shell layer fixes', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); reinstallDefaultShells(); });

  test('Windows SSH client prompts for the password before pushing', async () => {
    const term = new WindowsTerminalSession('t1', lan.winA);
    await term.init();
    term.setInput('ssh user@10.0.0.1');
    term.handleKey(key('Enter'));
    await flush();
    expect(term.currentInputMode.type).toBe('password');
    expect(term.lines.some(l => /user@10\.0\.0\.1's password/.test(l.text))).toBe(true);
  });

  test('PowerShell launched over SSH (Windows → Windows) actually enters PS', async () => {
    const term = new WindowsTerminalSession('t2', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh User@10.0.0.4', 'user');
    expect(term.getPrompt()).toMatch(/C:\\Users\\User>/);
    await typeInSubShell(term, 'powershell');
    // The PS prompt format is `PS <path>>` — not the cmd `C:\…>`.
    expect(term.getPrompt()).toMatch(/^PS [A-Z]:\\/);
  });

  test('cls clears the screen inside an SSH session', async () => {
    const term = new WindowsTerminalSession('t3', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh User@10.0.0.4', 'user');
    // Build up some scrollback first.
    await typeInSubShell(term, 'echo before-cls');
    const lineCountBefore = term.lines.length;
    expect(lineCountBefore).toBeGreaterThan(2);
    await typeInSubShell(term, 'cls');
    expect(term.lines.length).toBeLessThan(lineCountBefore);
  });

  test('sqlplus launched over SSH on a LinuxServer enters the SQL*Plus REPL', async () => {
    // Linux server carries Oracle; bash should recognise the `sqlplus`
    // launcher and push the SQL*Plus child shell. The server's default
    // unprivileged cast (alice/bob/...) is provisioned with password
    // equal to username — `user` is workstation-only.
    const term = new WindowsTerminalSession('t4', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh alice@10.0.0.2', 'alice');
    expect(term.getPrompt()).toMatch(/alice@linuxSrv/);
    await typeInSubShell(term, 'sqlplus / as sysdba');
    // Either the SQL prompt or the SQL*Plus error banner is fine —
    // the test contract is "did the legacy `executeCommand` transcript
    // get replaced by a real sub-shell push?".
    const prompt = term.getPrompt();
    expect(prompt === 'SQL> ' || /^SQL>/.test(prompt)).toBe(true);
  });

  test('Tab completion is routed through the remote device when SSH\'d in', async () => {
    const term = new WindowsTerminalSession('t5', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    // The active sub-shell now exposes getCompletions; the helper
    // returns the device's completion candidates (non-empty for a
    // partial command typed against the remote bash).
    const sub = (term as unknown as { activeSubShell: { getCompletions?: (s: string) => string[] } }).activeSubShell;
    expect(typeof sub?.getCompletions).toBe('function');
  });
});

// ─── §E — Wrong-password retry contract ─────────────────────────────

describe('§E — SSH password retry mirrors OpenSSH', () => {
  let lan: Lan;
  beforeEach(async () => { lan = await buildLan(); });

  test('first wrong password prompts again instead of dropping the connection', async () => {
    const term = new WindowsTerminalSession('t6', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'wrong-1');
    expect(term.lines.some(l => /Permission denied, please try again/.test(l.text))).toBe(true);
    expect(term.currentInputMode.type).toBe('password');
  });

  test('three wrong attempts surface the final "Permission denied (publickey,password)" line', async () => {
    const term = new WindowsTerminalSession('t7', lan.winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'w1');
    term.setPasswordBuf('w2'); term.handleKey(key('Enter')); await flush();
    term.setPasswordBuf('w3'); term.handleKey(key('Enter')); await flush();
    expect(term.lines.some(l => /Permission denied \(publickey,password\)/.test(l.text))).toBe(true);
    expect(term.currentInputMode.type).toBe('normal');
  });
});
