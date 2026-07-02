import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

async function enterPowerShell(session: WindowsTerminalSession): Promise<void> {
  session.setInput('powershell');
  session.handleKey(key('Enter'));
  await new Promise((r) => setTimeout(r, 60));
}

async function typePsLine(session: WindowsTerminalSession, line: string): Promise<void> {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await tick();
}

let win: WindowsPC;
let session: WindowsTerminalSession;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  win = new WindowsPC('windows-pc', 'PC1', 0, 0);
  win.powerOn();
  session = new WindowsTerminalSession('term-1', win);
  await session.init?.();
  await enterPowerShell(session);
});

describe('PowerShell Get-Content -Wait — tail-follow on the async pipeline', () => {
  it('emits existing content first, then new appended bytes appear within the polling window', async () => {
    win.getFileSystem().createFile('C:\\probe.log', 'line one\nline two\n');

    await typePsLine(session, 'Get-Content C:\\probe.log -Wait');
    await waitFor(session, (l) => l.some((t) => t === 'line one') && l.some((t) => t === 'line two'));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    win.getFileSystem().appendFile('C:\\probe.log', 'line three\n');
    await waitFor(session, (l) => l.some((t) => t === 'line three'), 3000);
    expect(texts(session).some((t) => t === 'line three')).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('-Tail N limits the initial dump to the last N lines', async () => {
    win.getFileSystem().createFile('C:\\big.log', 'a\nb\nc\nd\ne\n');
    await typePsLine(session, 'Get-Content C:\\big.log -Wait -Tail 2');
    await waitFor(session, (l) => l.some((t) => t === 'd') && l.some((t) => t === 'e'));
    expect(texts(session).some((t) => t === 'a')).toBe(false);
    expect(texts(session).some((t) => t === 'b')).toBe(false);
    expect(texts(session).some((t) => t === 'd')).toBe(true);
    expect(texts(session).some((t) => t === 'e')).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });

  it('alias cat/gc/type with -Wait fires the same path', async () => {
    win.getFileSystem().createFile('C:\\alias.log', 'hello\n');
    await typePsLine(session, 'cat C:\\alias.log -Wait');
    await waitFor(session, (l) => l.some((t) => t === 'hello'));
    expect(session.hasForegroundAsyncJob).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('Get-Content without -Wait falls through to the one-shot cmdlet (no streaming)', async () => {
    win.getFileSystem().createFile('C:\\one.log', 'just-once\n');
    await typePsLine(session, 'Get-Content C:\\one.log');
    await waitFor(session, (l) => l.some((t) => t === 'just-once'));
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('missing file silently waits — appears once created', async () => {
    await typePsLine(session, 'Get-Content C:\\not-yet.log -Wait');
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);

    win.getFileSystem().createFile('C:\\not-yet.log', 'finally-here\n');
    await waitFor(session, (l) => l.some((t) => t === 'finally-here'), 3000);
    expect(texts(session).some((t) => t === 'finally-here')).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });

  it('quoted paths are stripped of their wrapping quotes', async () => {
    win.getFileSystem().createFile('C:\\app.log', 'started\n');
    await typePsLine(session, 'Get-Content "C:\\app.log" -Wait');
    await waitFor(session, (l) => l.some((t) => t === 'started'));
    expect(texts(session).some((t) => t === 'started')).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });
});
