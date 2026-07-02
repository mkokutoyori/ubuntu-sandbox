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

function emitKernel(pc: LinuxPC, message: string, priority = 4): void {
  const mgr = (pc as unknown as { executor: { logMgr: {
    logKernel: (tag: string, message: string) => void;
    addEntry?: (opts: Record<string, unknown>) => void;
  } } }).executor.logMgr;
  if (priority === 4) { mgr.logKernel('kernel', message); return; }
  mgr.addEntry?.({
    priority,
    facility: 0,
    unit: 'kernel',
    tag: 'kernel',
    message,
    pid: 0,
    hostname: 'localhost',
  });
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('Linux dmesg -w — live kernel ring buffer follow on the async pipeline', () => {
  it('prints the existing buffer then streams new kernel entries until Ctrl+C', async () => {
    emitKernel(pc, 'probeDmesgHistoricalXYZ');

    session.setInput('dmesg -w');
    session.handleKey(key('Enter'));

    await waitFor(session, (l) => l.some((t) => t.includes('probeDmesgHistoricalXYZ')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    emitKernel(pc, 'probeDmesgLiveABC');
    await waitFor(session, (l) => l.some((t) => t.includes('probeDmesgLiveABC')));
    expect(texts(session).some((t) => t.includes('probeDmesgLiveABC'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);

    const before = texts(session).filter((t) => t.includes('probeDmesgPostCancel')).length;
    emitKernel(pc, 'probeDmesgPostCancel');
    await tick();
    expect(texts(session).filter((t) => t.includes('probeDmesgPostCancel')).length).toBe(before);
  });

  it('plain dmesg without -w falls through to the one-shot dump', async () => {
    emitKernel(pc, 'probeDmesgOneShotABC');

    session.setInput('dmesg');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('probeDmesgOneShotABC'))).toBe(true);
  });

  it('honours --level filter — drops new entries outside the requested levels', async () => {
    session.setInput('dmesg -w --level=err');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);

    emitKernel(pc, 'probeDmesgWarnLine', 4);
    emitKernel(pc, 'probeDmesgErrLine', 3);

    await waitFor(session, (l) => l.some((t) => t.includes('probeDmesgErrLine')));
    expect(texts(session).some((t) => t.includes('probeDmesgErrLine'))).toBe(true);
    expect(texts(session).some((t) => t.includes('probeDmesgWarnLine'))).toBe(false);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });

  it('rejects an unknown level filter without locking the prompt', async () => {
    session.setInput('dmesg -w -l bogus');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes("dmesg: unknown level 'bogus'"))).toBe(true);
  });

  it('keeps two concurrent sessions isolated', async () => {
    const other = new LinuxTerminalSession('term-2', pc);
    session.setInput('dmesg -w');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(other.hasForegroundAsyncJob).toBe(false);

    emitKernel(pc, 'probeDmesgIsoLine');
    await waitFor(session, (l) => l.some((t) => t.includes('probeDmesgIsoLine')));
    expect(texts(session).some((t) => t.includes('probeDmesgIsoLine'))).toBe(true);
    expect(texts(other).some((t) => t.includes('probeDmesgIsoLine'))).toBe(false);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
  });
});
