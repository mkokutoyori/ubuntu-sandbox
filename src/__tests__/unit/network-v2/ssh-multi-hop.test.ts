import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
async function sshFromHost(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 8 && host.foreground.currentInputMode.type !== 'password'; i++) await tick();
  if (host.foreground.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 8; i++) await tick();
}
function runOnForeground(host: TerminalSession, line: string): void {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
}
function texts(s: TerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: TerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

async function buildLab() {
  EquipmentRegistry.resetInstance();
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const linuxB = new LinuxPC('linux-pc', 'linuxB', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  [winA, linuxA, linuxB, winB, sw].forEach((d) => d.powerOn());
  new Cable('c1').connect(winA.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(linuxA.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(linuxB.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  new Cable('c4').connect(winB.getPort('eth0')!, sw.getPort('FastEthernet0/4')!);
  await winA.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.1 255.255.255.0');
  await linuxA.executeCommand('ifconfig eth0 10.0.0.2');
  await linuxB.executeCommand('ifconfig eth0 10.0.0.3');
  await winB.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.4 255.255.255.0');
  return { winA, linuxA, linuxB, winB };
}

describe('SSH from inside a remote session works recursively', () => {
  it('Win -> Linux -> Linux: the second (Linux target) hop is a REAL nested SshInteractiveSubShell', async () => {
    const { winA } = await buildLab();
    const host = new WindowsTerminalSession('h', winA);
    await host.init?.();
    await sshFromHost(host, 'ssh user@10.0.0.2', 'admin');
    expect(host.foreground).toBeInstanceOf(LinuxTerminalSession);
    const linuxHop = host.foreground;
    await sshFromHost(host, 'ssh user@10.0.0.3', 'admin');
    // Linux↔Linux drives the interactive session over the real,
    // authenticated SSH channel — no second child is pushed, so
    // `foreground` stays the same linuxA session; the second hop is a
    // REAL nested SshInteractiveSubShell (its own real SshSession to
    // linuxB, opened FROM linuxA's own SSH channel to linuxB — see
    // SshInteractiveSubShell.startNestedHop()), not a documented no-op.
    expect(host.foreground).toBe(linuxHop);
    expect(host.foreground.device.getName()).toBe('linuxA');
    const hop1 = (host.foreground as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(hop1).toBeInstanceOf(SshInteractiveSubShell);
    expect((hop1 as { getPrompt(): string }).getPrompt()).toMatch(/user@linuxB/);
  });

  it('exit from the nested ssh hop returns to the first hop, exit again pops to the host', async () => {
    const { winA } = await buildLab();
    const host = new WindowsTerminalSession('h', winA);
    await host.init?.();
    await sshFromHost(host, 'ssh user@10.0.0.2', 'admin');
    await sshFromHost(host, 'ssh user@10.0.0.3', 'admin');
    expect(host.foreground.device.getName()).toBe('linuxA');
    const hop1 = (host.foreground as unknown as { activeSubShell: { getPrompt(): string } }).activeSubShell;
    expect(hop1.getPrompt()).toMatch(/user@linuxB/);
    runOnForeground(host, 'exit');
    await tick();
    // Back on hop1 (linuxA -> linuxB), the nested hop is gone.
    expect(host.foreground.device.getName()).toBe('linuxA');
    expect(hop1.getPrompt()).toMatch(/user@linuxB/);
    runOnForeground(host, 'exit');
    await tick();
    expect(host.foreground).toBe(host);
  });

  it('Win -> Linux -> Win runs hostname on the grandchild Windows box', async () => {
    const { winA } = await buildLab();
    const host = new WindowsTerminalSession('h', winA);
    await host.init?.();
    await sshFromHost(host, 'ssh user@10.0.0.2', 'admin');
    await sshFromHost(host, 'ssh User@10.0.0.4', 'user');
    expect(host.foreground).toBeInstanceOf(WindowsTerminalSession);
    expect(host.foreground.device.getName()).toBe('winB');
    runOnForeground(host, 'hostname');
    await waitFor(host, (l) => l.some((t) => t === 'winB'));
    expect(texts(host)).toContain('winB');
  });

  it('ping streams over a two-hop SSH (Win -> Linux -> Linux)', async () => {
    const { winA } = await buildLab();
    const host = new WindowsTerminalSession('h', winA);
    await host.init?.();
    await sshFromHost(host, 'ssh user@10.0.0.2', 'admin');
    await sshFromHost(host, 'ssh user@10.0.0.3', 'admin');
    runOnForeground(host, 'ping 10.0.0.2');
    await waitFor(host, (l) => l.some((t) => /bytes from 10\.0\.0\.2/.test(t)));
    host.handleKey(key('c', { ctrlKey: true }));
    await waitFor(host, (l) => l.some((t) => /ping statistics/.test(t)));
  });
});
