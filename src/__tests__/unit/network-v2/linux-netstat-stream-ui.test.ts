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
function countHeader(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => t.startsWith('Proto Recv-Q Send-Q')).length;
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

describe('Linux netstat -c — continuous listing on the async pipeline', () => {
  it('reprints the table each interval, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('netstat -tc');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.startsWith('Proto Recv-Q Send-Q')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    // Continuous: the whole listing is reprinted (scrolls), so the column
    // header recurs — it is not a single one-shot dump.
    await waitFor(session, () => countHeader(session) >= 2);
    expect(countHeader(session)).toBeGreaterThanOrEqual(2);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('plain netstat without -c falls through to the one-shot path', async () => {
    session.setInput('netstat -t');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countHeader(session)).toBe(1);
  });

  it('keeps two concurrent sessions isolated', async () => {
    const other = new LinuxTerminalSession('term-2', pc);
    session.setInput('netstat -c');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith('Proto Recv-Q Send-Q')));

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(other.hasForegroundAsyncJob).toBe(false);
    expect(countHeader(other)).toBe(0);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
