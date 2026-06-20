import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }

async function waitFor(s: LinuxTerminalSession, pred: (lines: string[]) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred(texts(s))) return;
    await tick();
  }
}

let pc1: LinuxPC;
let pc2: LinuxPC;
let session: LinuxTerminalSession;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc2 = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  pc1.powerOn(); pc2.powerOn(); sw.powerOn();
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await pc1.executeCommand('ifconfig eth0 192.168.1.10');
  await pc2.executeCommand('ifconfig eth0 192.168.1.20');
  session = new LinuxTerminalSession('term-1', pc1);
});

describe('Linux ping — real-time streaming through the async pipeline', () => {
  it('streams replies progressively, locks the prompt, then prints statistics', async () => {
    session.setInput('ping -c 3 -i 0.05 192.168.1.20');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('icmp_seq=1')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, (l) => l.some((t) => t.includes('ping statistics')));
    const lines = texts(session);
    expect(lines.some((t) => t.startsWith('PING 192.168.1.20'))).toBe(true);
    expect(lines.filter((t) => t.includes('bytes from 192.168.1.20')).length).toBe(3);
    expect(lines.some((t) => t.includes('3 packets transmitted, 3 received'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('Ctrl+C interrupts an ongoing ping and prints the partial summary', async () => {
    session.setInput('ping 192.168.1.20');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('icmp_seq=1')));
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();

    const lines = texts(session);
    expect(lines.some((t) => t === '^C')).toBe(true);
    expect(lines.some((t) => t.includes('ping statistics'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('reuses real reachability — a non-existent on-link target is unreachable, not faked', async () => {
    session.setInput('ping -c 2 -W 0.2 192.168.1.99');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('Network is unreachable')), 4000);
    expect(texts(session).some((t) => t.includes('Network is unreachable'))).toBe(true);
    expect(texts(session).some((t) => t.includes('bytes from'))).toBe(false);
  });
});
