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
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
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
  await new Promise((r) => setTimeout(r, 50));
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

describe('Windows PowerShell — Test-NetConnection (real ping + TCP, end to end through the runtime)', () => {
  it('reachable host: PingSucceeded True with real source address and interface alias', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20');
    await waitFor(session, (l) => l.some((t) => /PingSucceeded/.test(t)));
    const lines = texts(session);
    expect(lines.some((t) => /ComputerName\s+:\s+192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /RemoteAddress\s+:\s+192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /InterfaceAlias\s+:\s+eth0/.test(t))).toBe(true);
    expect(lines.some((t) => /SourceAddress\s+:\s+192\.168\.1\.10/.test(t))).toBe(true);
    expect(lines.some((t) => /PingSucceeded\s+:\s+True/.test(t))).toBe(true);
  });

  it('unreachable host: PingSucceeded False', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.99.99');
    await waitFor(session, (l) => l.some((t) => /PingSucceeded/.test(t)));
    expect(texts(session).some((t) => /PingSucceeded\s+:\s+False/.test(t))).toBe(true);
  });

  it('-Port to a closed port: TcpTestSucceeded False', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -Port 12345');
    await waitFor(session, (l) => l.some((t) => /TcpTestSucceeded/.test(t)));
    const lines = texts(session);
    expect(lines.some((t) => /RemotePort\s+:\s+12345/.test(t))).toBe(true);
    expect(lines.some((t) => /TcpTestSucceeded\s+:\s+False/.test(t))).toBe(true);
  });

  it('-InformationLevel Quiet returns just True/False', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -InformationLevel Quiet');
    await waitFor(session, (l) => l.some((t) => t.trim() === 'True' || t.trim() === 'False'));
    expect(texts(session).some((t) => t.trim() === 'True')).toBe(true);
  });

  it('-InformationLevel Detailed adds NameResolutionResults + NetRouteNextHop', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -InformationLevel Detailed');
    await waitFor(session, (l) => l.some((t) => /PingSucceeded/.test(t)));
    const lines = texts(session);
    expect(lines.some((t) => /NameResolutionResults\s*:.*192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /NetRouteNextHop\s+:/.test(t))).toBe(true);
  });

  it('script use: $r.PingSucceeded works for assigned cmdlet output', async () => {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine('$r = Test-NetConnection 192.168.1.20; $r.PingSucceeded');
    expect(r.output.join('\n')).toContain('True');
  });

  it('script use: chained property access on Test-NetConnection', async () => {
    const sh = PowerShellSubShell.create(win).subShell;
    const r = await sh.processLine('(Test-NetConnection 192.168.1.20 -Port 12345).TcpTestSucceeded');
    expect(r.output.join('\n')).toContain('False');
  });
});
