import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress } from '@/network/core/types';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('Linux ip monitor — netlink event subscription on the async pipeline', () => {
  it('streams labelled LINK/ADDR/ROUTE changes live, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('ip monitor');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await pc.executeCommand('ip addr add 10.7.7.7/24 dev eth0');
    await waitFor(session, (l) => l.some((t) => t.startsWith('[ADDR]')));
    expect(texts(session).some((t) => t.includes('[ADDR]') && t.includes('inet 10.7.7.7/24'))).toBe(true);

    await pc.executeCommand('ip route add 10.5.0.0/24 via 10.7.7.1');
    await waitFor(session, (l) => l.some((t) => t.startsWith('[ROUTE]')));
    expect(texts(session).some((t) => t === '[ROUTE]10.5.0.0/24 via 10.7.7.1 dev eth0 metric 100')).toBe(true);

    await pc.executeCommand('ip link set eth0 down');
    await waitFor(session, (l) => l.some((t) => t.startsWith('[LINK]')));
    expect(texts(session).some((t) => t.startsWith('[LINK]') && t.includes('eth0:') && t.includes('state DOWN'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);

    const before = texts(session).filter((t) => t.startsWith('[ROUTE]')).length;
    await pc.executeCommand('ip route add 10.6.0.0/24 via 10.7.7.1');
    await tick();
    expect(texts(session).filter((t) => t.startsWith('[ROUTE]')).length).toBe(before);
  });

  it('reports the default route being added and deleted', async () => {
    await pc.executeCommand('ip addr add 10.7.7.7/24 dev eth0');

    session.setInput('ip monitor route');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);

    await pc.executeCommand('ip route add default via 10.7.7.1');
    await waitFor(session, (l) => l.some((t) => t.startsWith('default')));
    expect(texts(session).some((t) => t === 'default via 10.7.7.1 dev eth0')).toBe(true);

    await pc.executeCommand('ip route del default');
    await waitFor(session, (l) => l.some((t) => t.startsWith('Deleted default')));
    expect(texts(session).some((t) => t === 'Deleted default dev eth0')).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('does not re-announce an unchanged default gateway', async () => {
    await pc.executeCommand('ip addr add 10.8.8.8/24 dev eth0');
    await pc.executeCommand('ip route add default via 10.8.8.1');

    session.setInput('ip monitor route');
    session.handleKey(key('Enter'));
    await tick();

    pc.setDefaultGateway(new IPAddress('10.8.8.1'));
    await tick();
    expect(texts(session).some((t) => t.startsWith('default'))).toBe(false);
  });

  it('a single object filter is unlabelled and only reports that object', async () => {
    session.setInput('ip monitor address');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);

    await pc.executeCommand('ip addr add 192.168.50.4/24 dev eth0');
    await waitFor(session, (l) => l.some((t) => t.includes('inet 192.168.50.4/24')));
    const addrLine = texts(session).find((t) => t.includes('inet 192.168.50.4/24'))!;
    expect(addrLine.startsWith('[ADDR]')).toBe(false);
    expect(addrLine).toContain('eth0    inet 192.168.50.4/24');

    await pc.executeCommand('ip link set eth0 down');
    await tick();
    expect(texts(session).some((t) => t.startsWith('[LINK]') || t.includes('state DOWN'))).toBe(false);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('delivers events independently to concurrent sessions on the same host', async () => {
    const session2 = new LinuxTerminalSession('term-2', pc);
    session.setInput('ip monitor address');
    session.handleKey(key('Enter'));
    session2.setInput('ip monitor address');
    session2.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session2.hasForegroundAsyncJob).toBe(true);

    await pc.executeCommand('ip addr add 172.16.9.9/24 dev eth0');
    await waitFor(session, (l) => l.some((t) => t.includes('172.16.9.9/24')));
    await waitFor(session2, (l) => l.some((t) => t.includes('172.16.9.9/24')));
    expect(texts(session).some((t) => t.includes('172.16.9.9/24'))).toBe(true);
    expect(texts(session2).some((t) => t.includes('172.16.9.9/24'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session2.hasForegroundAsyncJob).toBe(true);

    session2.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session2.hasForegroundAsyncJob).toBe(false);
  });
});
