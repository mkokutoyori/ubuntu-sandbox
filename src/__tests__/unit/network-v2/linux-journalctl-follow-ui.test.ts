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

async function waitFor(s: LinuxTerminalSession, pred: (lines: string[]) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred(texts(s))) return;
    await tick();
  }
}

let pc: LinuxPC;
let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('Linux journalctl -f — event subscription through the async pipeline', () => {
  it('locks the prompt, prints the journal header, then streams new entries live', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.startsWith('-- Logs begin at')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await pc.executeCommand('logger -t streamtag hello-from-journal');

    await waitFor(session, (l) => l.some((t) => t.includes('streamtag') && t.includes('hello-from-journal')));
    expect(texts(session).some((t) => t.includes('hello-from-journal'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(true);
  });

  it('Ctrl+C stops the follow, frees the prompt, and detaches the subscription', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith('-- Logs begin at')));

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();

    expect(texts(session).some((t) => t === '^C')).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);

    await pc.executeCommand('logger -t streamtag after-cancel');
    await tick();
    expect(texts(session).some((t) => t.includes('after-cancel'))).toBe(false);
  });

  it('honours the -u filter so only matching units stream into the terminal', async () => {
    session.setInput('journalctl -f -u myunit');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith('-- Logs begin at')));

    await pc.executeCommand('logger -t other off-topic-line');
    await pc.executeCommand('logger -t myunit on-topic-line');

    await waitFor(session, (l) => l.some((t) => t.includes('on-topic-line')));
    expect(texts(session).some((t) => t.includes('on-topic-line'))).toBe(true);
    expect(texts(session).some((t) => t.includes('off-topic-line'))).toBe(false);
  });

  it('a plain journalctl (no -f) is unaffected — snapshot dump, no foreground job', async () => {
    session.setInput('journalctl -n 5');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });
});
