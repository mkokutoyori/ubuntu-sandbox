import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: TerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: TerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}
async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.setInputBuf(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 4 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 4; i++) await tick();
}
function runOnForeground(host: TerminalSession, line: string): void {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
}

const subShellOf = (host: TerminalSession): unknown =>
  (host as unknown as { activeSubShell: unknown }).activeSubShell;

describe('SSH Windows -> Linux is a transparent transport for behaviour', () => {
  let win: WindowsPC;
  let host: WindowsTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const linux = new LinuxPC('linux-pc', 'PC2', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
    win.powerOn(); linux.powerOn(); sw.powerOn();
    new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
    await linux.executeCommand('ifconfig eth0 192.168.1.20');
    host = new WindowsTerminalSession('term-1', win);
    await host.init?.();
  });

  it('lands on the real-wire sub-shell after login, not a local child session', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');

    // The hop is driven over the real, authenticated SSH channel: no
    // child session is pushed, so `foreground` stays the host and the
    // sub-shell is the tell (docs/PRD-SSH-Unification.md §4bis B4).
    expect(host.foreground).toBe(host);
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);
  });

  it('ping streams reply-by-reply over SSH, exactly like a local Linux terminal', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    runOnForeground(host, 'ping 192.168.1.10');

    await waitFor(host, (l) => l.some((t) => /bytes from 192\.168\.1\.10/.test(t)));
    expect(texts(host).some((t) => /bytes from 192\.168\.1\.10/.test(t))).toBe(true);

    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(host, (l) => l.some((t) => /ping statistics/.test(t)));
  });

  it('journalctl -f follows the log over SSH', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    const before = texts(host).length;
    runOnForeground(host, 'journalctl -f');

    await waitFor(host, (l) => l.length > before);
    host.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);
  });

  it('exit closes the remote session and returns to the Windows host', async () => {
    await sshLogin(host, 'ssh user@192.168.1.20', 'admin');
    expect(subShellOf(host)).toBeInstanceOf(SshInteractiveSubShell);

    runOnForeground(host, 'exit');
    await tick();
    expect(host.foreground).toBe(host);
    expect(subShellOf(host)).toBeNull();
    expect(texts(host)).toContain('Connection to 192.168.1.20 closed.');
  });
});
