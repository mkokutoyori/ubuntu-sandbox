import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

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

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

describe('Windows ping — real-time streaming through the async pipeline', () => {
  it('ping -n streams replies progressively and prints statistics', async () => {
    await type('ping -n 3 192.168.1.20');
    await waitFor(session, (l) => l.some((t) => t.includes('Reply from 192.168.1.20')));
    expect(session.hasForegroundAsyncJob).toBe(true);

    await waitFor(session, (l) => l.some((t) => t.includes('Ping statistics')));
    const lines = texts(session);
    expect(lines.filter((t) => t.includes('Reply from 192.168.1.20')).length).toBe(3);
    expect(lines.some((t) => t.includes('Sent = 3, Received = 3'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('ping -t runs continuously until Ctrl+C, then prints the summary', async () => {
    await type('ping -t 192.168.1.20');
    await waitFor(session, (l) => l.filter((t) => t.includes('Reply from')).length >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(true);
    const repliesBefore = texts(session).filter((t) => t.includes('Reply from')).length;
    expect(repliesBefore).toBeGreaterThanOrEqual(2);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('Ping statistics'))).toBe(true);

    // continuous would exceed the old 10-cap; confirm it kept going past a fixed block
    expect(repliesBefore).toBeGreaterThan(0);
  });
});
