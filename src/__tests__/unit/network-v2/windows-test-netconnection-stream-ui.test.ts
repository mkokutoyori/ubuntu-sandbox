import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseWinTestNetConnectionArgs,
  formatWinTestNetConnection,
} from '@/network/devices/windows/WinTestNetConnection';

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

describe('Windows PowerShell — Test-NetConnection (real ping + TCP)', () => {
  it('reachable host: PingSucceeded True with real source address and interface alias', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20');
    await waitFor(session, (l) => l.some((t) => t.startsWith('PingSucceeded')));
    const lines = texts(session);
    expect(lines.some((t) => /^ComputerName\s+:\s+192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /^RemoteAddress\s+:\s+192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /^InterfaceAlias\s+:\s+eth0/.test(t))).toBe(true);
    expect(lines.some((t) => /^SourceAddress\s+:\s+192\.168\.1\.10/.test(t))).toBe(true);
    expect(lines.some((t) => /^PingSucceeded\s+:\s+True/.test(t))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('unreachable host: PingSucceeded False, no warning crash', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.99.99');
    await waitFor(session, (l) => l.some((t) => t.startsWith('PingSucceeded')));
    const lines = texts(session);
    expect(lines.some((t) => t.includes('WARNING: Ping to 192.168.99.99 failed'))).toBe(true);
    expect(lines.some((t) => /^PingSucceeded\s+:\s+False/.test(t))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('-Port to a closed port: TcpTestSucceeded False', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -Port 12345');
    await waitFor(session, (l) => l.some((t) => t.startsWith('TcpTestSucceeded')));
    const lines = texts(session);
    expect(lines.some((t) => /^RemotePort\s+:\s+12345/.test(t))).toBe(true);
    expect(lines.some((t) => /^TcpTestSucceeded\s+:\s+False/.test(t))).toBe(true);
  });

  it('-InformationLevel Quiet returns just True/False', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -InformationLevel Quiet');
    await waitFor(session, (l) => l.some((t) => t === 'True' || t === 'False'));
    expect(texts(session).some((t) => t === 'True')).toBe(true);
  });

  it('-InformationLevel Detailed adds NameResolutionResults + NetRoute', async () => {
    await typePsLine(session, 'Test-NetConnection 192.168.1.20 -InformationLevel Detailed');
    await waitFor(session, (l) => l.some((t) => t.startsWith('PingSucceeded')));
    const lines = texts(session);
    expect(lines.some((t) => /^NameResolutionResults\s+:\s+192\.168\.1\.20/.test(t))).toBe(true);
    expect(lines.some((t) => /^NetRoute \(NextHop\)\s+:/.test(t))).toBe(true);
  });
});

describe('Windows Test-NetConnection — pure parser + formatters', () => {
  it('parses positional target, -ComputerName, -Port, -CommonTCPPort, -InformationLevel', () => {
    expect(parseWinTestNetConnectionArgs(['8.8.8.8'])).toMatchObject({ target: '8.8.8.8', level: 'standard' });
    expect(parseWinTestNetConnectionArgs(['-ComputerName', 'h', '-Port', '80']))
      .toMatchObject({ target: 'h', port: 80, level: 'standard' });
    expect(parseWinTestNetConnectionArgs(['h', '-CommonTCPPort', 'HTTP']))
      .toMatchObject({ target: 'h', port: 80 });
    expect(parseWinTestNetConnectionArgs(['h', '-CommonTCPPort', 'SMB']))
      .toMatchObject({ port: 445 });
    expect(parseWinTestNetConnectionArgs(['h', '-CommonTCPPort', 'RDP']))
      .toMatchObject({ port: 3389 });
    expect(parseWinTestNetConnectionArgs(['h', '-CommonTCPPort', 'WinRM']))
      .toMatchObject({ port: 5985 });
    expect(parseWinTestNetConnectionArgs(['h', '-InformationLevel', 'Detailed']))
      .toMatchObject({ level: 'detailed' });
  });

  it('strips quotes around the target', () => {
    expect(parseWinTestNetConnectionArgs(['"h.local"'])).toMatchObject({ target: 'h.local' });
  });

  it('returns null when target is missing', () => {
    expect(parseWinTestNetConnectionArgs([])).toBeNull();
    expect(parseWinTestNetConnectionArgs(['-Port', '80'])).toBeNull();
  });

  it('quiet returns only True or False', () => {
    const lines = formatWinTestNetConnection({
      computerName: 'h', remoteAddress: '1.2.3.4', nameResolved: true,
      interfaceAlias: 'eth0', sourceAddress: '1.2.3.1', netRouteNextHop: '0.0.0.0',
      pingSucceeded: true, pingRttMs: 1, tcpTested: false, tcpSucceeded: false,
      level: 'quiet',
    });
    expect(lines).toEqual(['True']);
  });
});
