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

describe('Linux top — refreshing monitor on the async pipeline', () => {
  it('repaints the top frame in place, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('top -d 0.1');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.startsWith('top -')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);
    expect(texts(session).some((t) => t.includes('%Cpu'))).toBe(true);

    const lenA = session.lines.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(session.lines.length).toBeLessThanOrEqual(lenA + 1);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });
});

describe('Linux journalctl -f — live journal follow on the async pipeline', () => {
  it('prints the tail then streams new entries until Ctrl+C', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await pc.executeCommand('logger probeJournalLineXYZ');
    await waitFor(session, (l) => l.some((t) => t.includes('probeJournalLineXYZ')));
    expect(texts(session).some((t) => t.includes('probeJournalLineXYZ'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);

    const countAfter = texts(session).filter((t) => t.includes('probeJournalLineXYZ')).length;
    await pc.executeCommand('logger probeJournalLineXYZ');
    await tick();
    expect(texts(session).filter((t) => t.includes('probeJournalLineXYZ')).length).toBe(countAfter);
  });
});
