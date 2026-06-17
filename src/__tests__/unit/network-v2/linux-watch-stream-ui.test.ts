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

describe('Linux watch — real-time refreshing monitor on the async pipeline', () => {
  it('renders a refreshing frame in place, locks the prompt, stops on Ctrl+C', async () => {
    session.setInput('watch -n 0.1 echo tick');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('Every 0.1s: echo tick')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);
    expect(texts(session).some((t) => t === 'tick')).toBe(true);

    // In-place repaint: after several refreshes the line count stays bounded
    // (the watch region is truncated and redrawn, not appended forever).
    const lenA = session.lines.length;
    await new Promise((r) => setTimeout(r, 400));
    const lenB = session.lines.length;
    expect(lenB).toBeLessThanOrEqual(lenA + 1);
    expect(texts(session).some((t) => t === 'tick')).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('non-streaming watch with no command falls through to the one-shot path', async () => {
    session.setInput('watch');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
