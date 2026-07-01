import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));
function texts(s: CiscoTerminalSession): string[] { return s.lines.map((l) => l.text); }

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitFor(s: CiscoTerminalSession, pred: (lines: string[]) => boolean, ms = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred(texts(s))) return;
    await flush();
  }
}

describe('Cisco IOS ping — real-time streaming through the async pipeline', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let r1: CiscoRouter;
  let r2: CiscoRouter;
  let session: CiscoTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);

    r1 = new CiscoRouter('R1');
    r2 = new CiscoRouter('R2');
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    for (const [r, ip] of [[r1, '10.0.0.1'], [r2, '10.0.0.2']] as const) {
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand(`ip address ${ip} 255.255.255.0`);
      await r.executeCommand('no shutdown');
      await r.executeCommand('end');
    }

    manager = new TerminalManager(bus);
    const sid = manager.openTerminal(r1)!;
    session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
  });

  it('paints the !!!!! marks progressively, locks the prompt, then the success rate', async () => {
    session.setInput('ping 10.0.0.2');
    session.handleKey(key('Enter'));

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, (l) => l.some((t) => t.includes('Success rate is')));
    const lines = texts(session);
    expect(lines.some((t) => t === 'Type escape sequence to abort.')).toBe(true);
    expect(lines.some((t) => t.includes('100-byte ICMP Echos to 10.0.0.2'))).toBe(true);
    expect(lines.some((t) => t === '!!!!!')).toBe(true);
    expect(lines.some((t) => t.includes('Success rate is 100 percent (5/5)'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('Ctrl+C aborts an in-flight ping and prints the partial success rate', async () => {
    session.setInput('ping 10.0.0.50');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.startsWith('Sending 5,')));
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();

    const lines = texts(session);
    expect(lines.some((t) => t === '^C')).toBe(true);
    expect(lines.some((t) => t.includes('Success rate is'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('an off-subnet target with no route is a real 0 percent, not faked', async () => {
    session.setInput('ping 8.8.8.8');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('Success rate is')));
    const lines = texts(session);
    expect(lines.some((t) => t === '.....')).toBe(true);
    expect(lines.some((t) => t.includes('Success rate is 0 percent (0/5)'))).toBe(true);
    expect(lines.some((t) => t === '!!!!!')).toBe(false);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('two terminals on the same router each drive their own ping independently', async () => {
    const sid2 = manager.openTerminal(r1)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    await waitBoot(session2);

    session.setInput('ping 10.0.0.2');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.includes('Success rate is 100 percent')));

    expect(session2.lines.some((l) => l.text.includes('Success rate is'))).toBe(false);
    expect(session2.hasForegroundAsyncJob).toBe(false);

    session2.setInput('ping 10.0.0.2');
    session2.handleKey(key('Enter'));
    await waitFor(session2, (l) => l.some((t) => t.includes('Success rate is 100 percent')));
    expect(session2.lines.some((l) => l.text === '!!!!!')).toBe(true);
  });
});
