import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }
function lineTexts(s: LinuxTerminalSession): string[] {
  return s.lines.map((l) => l.text);
}
function logMgr(pc: LinuxPC): { logDaemon(tag: string, message: string): void } {
  return (pc as unknown as { executor: { logMgr: { logDaemon(tag: string, message: string): void } } })
    .executor.logMgr;
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('journalctl -f integration through LinuxTerminalSession', () => {
  it('J1 prints the recent tail then streams new journal entries live', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));
    await flush();

    expect(lineTexts(session).some((t) => t.includes('Server listening'))).toBe(true);

    logMgr(pc).logDaemon('myapp', 'live-entry-1');
    await flush();
    expect(lineTexts(session).some((t) => t.includes('live-entry-1'))).toBe(true);

    logMgr(pc).logDaemon('myapp', 'live-entry-2');
    await flush();
    expect(lineTexts(session).some((t) => t.includes('live-entry-2'))).toBe(true);
  });

  it('J2 Ctrl+C cancels the stream — further entries are silent', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));
    await flush();

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();
    const lineCountAfterCancel = session.lines.length;
    expect(lineTexts(session).some((t) => t === '^C')).toBe(true);

    logMgr(pc).logDaemon('myapp', 'silent-now');
    await flush();
    expect(session.lines.length).toBe(lineCountAfterCancel);
  });

  it('J3 -u filters the live stream to the matching unit', async () => {
    session.setInput('journalctl -f -u nginx');
    session.handleKey(key('Enter'));
    await flush();

    logMgr(pc).logDaemon('nginx', 'nginx-live-line');
    logMgr(pc).logDaemon('postgres', 'postgres-live-line');
    await flush();

    expect(lineTexts(session).some((t) => t.includes('nginx-live-line'))).toBe(true);
    expect(lineTexts(session).some((t) => t.includes('postgres-live-line'))).toBe(false);
  });

  it('J4 the React notify counter advances on each streamed entry', async () => {
    session.setInput('journalctl -f');
    session.handleKey(key('Enter'));
    await flush();

    const v0 = session.getVersion();
    logMgr(pc).logDaemon('myapp', 'tick');
    await flush();
    expect(session.getVersion()).toBeGreaterThan(v0);
  });

  it('J5 non-follow journalctl falls through the normal command path (no stream)', async () => {
    session.setInput('journalctl -n 2');
    session.handleKey(key('Enter'));
    await flush();

    const lineCountAfterBlock = session.lines.length;

    logMgr(pc).logDaemon('myapp', 'after-block');
    await flush();
    expect(session.lines.length).toBe(lineCountAfterBlock);
    expect(lineTexts(session).some((t) => t.includes('after-block'))).toBe(false);
  });
});
