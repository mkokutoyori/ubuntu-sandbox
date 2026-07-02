import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress } from '@/network/core/types';
import { formatWinPingHeader } from '@/network/devices/windows/WinPing';
import { formatWinTracertHeader } from '@/network/devices/windows/WinTracert';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

describe('Windows tracert — real-time streaming through the async pipeline', () => {
  let win: WindowsPC;
  let session: WindowsTerminalSession;

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
    session = new WindowsTerminalSession('term-1', win);
    await session.init?.();
  });

  it('tracert streams the route through the async pipeline', async () => {
    session.setInput('tracert 192.168.1.20');
    session.handleKey(key('Enter'));
    expect(session.hasForegroundAsyncJob).toBe(true);

    await waitFor(session, (l) => l.some((t) => t.includes('Trace complete')));
    const lines = texts(session);
    expect(lines.some((t) => t.includes('Tracing route to'))).toBe(true);
    expect(lines.some((t) => t.includes('192.168.1.20'))).toBe(true);
    expect(lines.some((t) => t.includes('Trace complete'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});

describe('Windows ping/tracert headers — host [ip] for named targets', () => {
  it('ping header shows host [ip] for a named target', () => {
    expect(formatWinPingHeader(new IPAddress('10.0.0.5'), 32, 'web'))
      .toBe('\nPinging web [10.0.0.5] with 32 bytes of data:');
  });

  it('ping header is plain for a numeric target', () => {
    expect(formatWinPingHeader(new IPAddress('10.0.0.5'), 32))
      .toBe('\nPinging 10.0.0.5 with 32 bytes of data:');
  });

  it('tracert header shows host [ip] for a named target', () => {
    expect(formatWinTracertHeader(new IPAddress('10.0.0.5'), 30, 'web')[1])
      .toBe('Tracing route to web [10.0.0.5] over a maximum of 30 hops:');
  });
});
