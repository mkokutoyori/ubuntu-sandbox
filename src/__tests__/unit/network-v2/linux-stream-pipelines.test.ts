/*
 * A streaming command followed by line-wise filters keeps streaming on the local terminal (tail -f f | grep x, a leading
 * command before the stream).  Measured before the catalogue accepted pipes and sequences (git stash push -- src/terminal
 * src/network): the three streaming cases fall - the line runs once and returns.  The whole-input filter case (wc) is the
 * WITNESS that a pipe the catalogue cannot stream is still left to the normal path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
const texts = (s: LinuxTerminalSession): string[] => s.lines.map((l) => l.text);
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}
function run(s: LinuxTerminalSession, line: string): void {
  s.setInput(line);
  s.handleKey(key('Enter'));
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
  await pc.executeCommand('echo seed > /tmp/p.log');
});

describe('streaming pipelines and sequences on the local terminal', () => {
  it('tail -f | grep shows only the matching appended lines and stops on Ctrl+C', async () => {
    run(session, "tail -f /tmp/p.log | grep ERROR");
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    await pc.executeCommand('echo "INFO quiet" >> /tmp/p.log');
    await pc.executeCommand('echo "ERROR loud" >> /tmp/p.log');
    await waitFor(session, (l) => l.includes('ERROR loud'));
    expect(texts(session)).toContain('ERROR loud');
    expect(texts(session)).not.toContain('INFO quiet');
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('a leading command runs once, then the last one streams', async () => {
    run(session, 'echo header-line; tail -f /tmp/p.log');
    await waitFor(session, (l) => l.includes('seed'));
    expect(texts(session)).toContain('header-line');
    expect(session.hasForegroundAsyncJob).toBe(true);
    session.handleKey(key('c', { ctrlKey: true }));
  });

  it('dmesg -w | grep keeps only the matching kernel messages', async () => {
    run(session, 'dmesg -w | grep probe');
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(true);
    const logMgr = (pc as unknown as { executor: { logMgr: { logAt(f: string, t: string, m: string): void } } }).executor.logMgr;
    logMgr.logAt('kern.warn', 'kernel', 'probe: kept');
    logMgr.logAt('kern.warn', 'kernel', 'other: dropped');
    await waitFor(session, (l) => l.some((t) => t.includes('probe: kept')));
    expect(texts(session).some((t) => t.includes('probe: kept'))).toBe(true);
    expect(texts(session).some((t) => t.includes('other: dropped'))).toBe(false);
    session.handleKey(key('c', { ctrlKey: true }));
  });

  it('WITNESS -- a pipe into a whole-input filter is left to the normal path', async () => {
    run(session, 'tail -f /tmp/p.log | wc -l');
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
