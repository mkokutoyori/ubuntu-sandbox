import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
function countMemRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^Mem:\s+\d+/.test(t)).length;
}
function countHeader(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /total\s+used\s+free\s+shared/.test(t)).length;
}
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
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

describe('Linux free — one-shot fallback', () => {
  it('plain free without -s falls through to the one-shot path', async () => {
    session.setInput('free');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countMemRows(session)).toBe(1);
  });
});

describe('Linux free -s N — scrolling monitor on the async pipeline', () => {
  it('reprints the table each interval, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('free -s 1');
    session.handleKey(key('Enter'));
    await waitFor(session, () => countMemRows(session) >= 1);
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, () => countMemRows(session) >= 2);
    expect(countMemRows(session)).toBeGreaterThanOrEqual(2);
    expect(countHeader(session)).toBeGreaterThanOrEqual(2);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('-c N exits on its own after N samples', async () => {
    session.setInput('free -s 1 -c 2');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countMemRows(session) >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countMemRows(session)).toBe(2);
  });

  it('keeps two concurrent sessions isolated', async () => {
    const other = new LinuxTerminalSession('term-2', pc);
    session.setInput('free -s 1');
    session.handleKey(key('Enter'));
    await waitFor(session, () => countMemRows(session) >= 1);

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(other.hasForegroundAsyncJob).toBe(false);
    expect(countMemRows(other)).toBe(0);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('preserves rendering flags like -h (human-readable)', async () => {
    session.setInput('free -h -s 1 -c 1');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countMemRows(session) >= 1, 4000);
    expect(texts(session).some((t) => /^Mem:\s+\S+[KMG]i\b/.test(t))).toBe(true);
  });
});
