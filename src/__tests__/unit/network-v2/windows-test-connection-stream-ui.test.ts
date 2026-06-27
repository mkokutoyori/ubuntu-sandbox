import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

async function enterPowerShell(session: WindowsTerminalSession): Promise<void> {
  session.setInput('powershell');
  session.handleKey(key('Enter'));
  await new Promise((r) => setTimeout(r, 60));
}

async function typePsLine(session: WindowsTerminalSession, line: string): Promise<void> {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await tick();
}

let win: WindowsPC;
let linux: LinuxPC;
let session: WindowsTerminalSession;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  win = new WindowsPC('windows-pc', 'PC1', 0, 0);
  linux = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  win.powerOn(); linux.powerOn(); sw.powerOn();
  new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
  await linux.executeCommand('ifconfig eth0 192.168.1.20');
  session = new WindowsTerminalSession('term-1', win);
  await session.init?.();
  await enterPowerShell(session);
});

describe('PowerShell Test-Connection — real RTT via the sync probe', () => {
  it('reachable host: Status Success with a non-zero Time(ms) and a real source', async () => {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine('Test-Connection -ComputerName 192.168.1.20 -Count 1');
    const out = r.output.join('\n');
    expect(out).toContain('Success');
    expect(out).toContain('192.168.1.20');
    expect(out).toMatch(/192\.168\.1\.10/);
  });

  it('unreachable host: Status Failure', async () => {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine('Test-Connection 192.168.99.99 -Count 1');
    expect(r.output.join('\n')).toContain('Failure');
  });

  it('-Quiet returns just True/False', async () => {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine('Test-Connection 192.168.1.20 -Count 1 -Quiet');
    expect(r.output.join('\n').trim()).toBe('True');
  });
});

describe('PowerShell Test-Connection -Continuous — streams rows on the async pipeline', () => {
  it('streams a header + a reply row per delay tick until Ctrl+C', async () => {
    await typePsLine(session, 'Test-Connection 192.168.1.20 -Continuous -Delay 1');
    await waitFor(session, (l) => l.some((t) => /^Source\s+Destination/.test(t)));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, (l) => l.filter((t) => /192\.168\.1\.20/.test(t)).length >= 1);
    expect(texts(session).some((t) => /192\.168\.1\.20.*\d+/.test(t))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('-Count 0 is treated as continuous', async () => {
    await typePsLine(session, 'Test-Connection 192.168.1.20 -Count 0 -Delay 1');
    await waitFor(session, (l) => l.some((t) => /^Source\s+Destination/.test(t)));
    expect(session.hasForegroundAsyncJob).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('unreachable host: TimedOut shown per tick', async () => {
    await typePsLine(session, 'Test-Connection 192.168.99.99 -Continuous -Delay 1');
    await waitFor(session, (l) => l.some((t) => /TimedOut/.test(t)));
    expect(texts(session).some((t) => /TimedOut/.test(t))).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });
});
