import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
function countHeader(s: WindowsTerminalSession): number {
  return texts(s).filter((t) => t.trim() === 'Active Connections').length;
}
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

let win: WindowsPC;
let session: WindowsTerminalSession;
beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  win = new WindowsPC('windows-pc', 'PC1', 0, 0);
  win.powerOn();
  session = new WindowsTerminalSession('term-1', win);
  await session.init?.();
});

describe('Windows netstat <interval> — real-time refresh on the async pipeline', () => {
  it('reprints the table each interval, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('netstat -an 1');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.trim() === 'Active Connections'));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, () => countHeader(session) >= 2);
    expect(countHeader(session)).toBeGreaterThanOrEqual(2);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('plain netstat without interval falls through to the one-shot path', async () => {
    session.setInput('netstat -an');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countHeader(session)).toBe(1);
  });

  it('bare netstat with just an interval also streams', async () => {
    session.setInput('netstat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.trim() === 'Active Connections'));
    expect(session.hasForegroundAsyncJob).toBe(true);
    await waitFor(session, () => countHeader(session) >= 2);
    expect(countHeader(session)).toBeGreaterThanOrEqual(2);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('keeps two concurrent sessions isolated', async () => {
    const other = new WindowsTerminalSession('term-2', win);
    await other.init?.();
    session.setInput('netstat -an 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.trim() === 'Active Connections'));

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(other.hasForegroundAsyncJob).toBe(false);
    expect(countHeader(other)).toBe(0);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
