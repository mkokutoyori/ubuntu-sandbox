/**
 * tail -f — UI integration spec.
 *
 * Drives the full chain that a React TerminalView sees:
 *   - user types `tail -f /var/log/syslog` and presses Enter
 *   - LinuxTerminalSession intercepts, opens a follow stream on the
 *     LinuxMachine's VFS, addLine() pumps each appended line so React's
 *     subscriber list (notify()) re-renders the buffer
 *   - external writes to the file arrive as new lines in `session.lines`
 *   - Ctrl+C cancels the stream and re-enables normal input
 */

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

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('tail -f integration through LinuxTerminalSession', () => {
  it('U1 starts a follow stream, addLine receives appended writes', async () => {
    const vfs = (pc as unknown as { executor: { vfs: typeof pc['executor']['vfs'] } }).executor.vfs;
    vfs.writeFile('/var/log/syslog', 'seed-line\n', 0, 0, 0o022);

    session.setInput('tail -f /var/log/syslog');
    session.handleKey(key('Enter'));
    await flush();

    expect(lineTexts(session).some((t) => t.includes('seed-line'))).toBe(true);

    vfs.writeFile('/var/log/syslog', 'live-line-1\n', 0, 0, 0o022, true);
    vfs.writeFile('/var/log/syslog', 'live-line-2\n', 0, 0, 0o022, true);
    await flush();

    expect(lineTexts(session).some((t) => t.includes('live-line-1'))).toBe(true);
    expect(lineTexts(session).some((t) => t.includes('live-line-2'))).toBe(true);
  });

  it('U2 Ctrl+C cancels the stream — further writes are silent', async () => {
    const vfs = (pc as unknown as { executor: { vfs: typeof pc['executor']['vfs'] } }).executor.vfs;
    vfs.writeFile('/tmp/app.log', 'init\n', 0, 0, 0o022);

    session.setInput('tail -f /tmp/app.log');
    session.handleKey(key('Enter'));
    await flush();

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();
    const lineCountAfterCancel = session.lines.length;
    expect(lineTexts(session).some((t) => t === '^C')).toBe(true);

    vfs.writeFile('/tmp/app.log', 'silent-now\n', 0, 0, 0o022, true);
    await flush();
    expect(session.lines.length).toBe(lineCountAfterCancel);
  });

  it('U3 Enter during an active stream emits a blank line and keeps streaming', async () => {
    const vfs = (pc as unknown as { executor: { vfs: typeof pc['executor']['vfs'] } }).executor.vfs;
    vfs.writeFile('/tmp/a.log', 'A\n', 0, 0, 0o022);

    session.setInput('tail -f /tmp/a.log');
    session.handleKey(key('Enter'));
    await flush();

    session.handleKey(key('Enter'));
    await flush();
    vfs.writeFile('/tmp/a.log', 'still-live\n', 0, 0, 0o022, true);
    await flush();

    expect(lineTexts(session).some((t) => t.includes('still-live'))).toBe(true);
  });

  it('U4 the React notify counter advances on each streamed line', async () => {
    const vfs = (pc as unknown as { executor: { vfs: typeof pc['executor']['vfs'] } }).executor.vfs;
    vfs.writeFile('/tmp/notify.log', 'init\n', 0, 0, 0o022);

    session.setInput('tail -f /tmp/notify.log');
    session.handleKey(key('Enter'));
    await flush();

    const v0 = session.getVersion();
    vfs.writeFile('/tmp/notify.log', 'tick\n', 0, 0, 0o022, true);
    await flush();
    expect(session.getVersion()).toBeGreaterThan(v0);
  });

  it('U5 non-follow `tail` falls through the normal command path (no stream)', async () => {
    const vfs = (pc as unknown as { executor: { vfs: typeof pc['executor']['vfs'] } }).executor.vfs;
    vfs.writeFile('/tmp/static.log', 'one\ntwo\nthree\n', 0, 0, 0o022);

    session.setInput('tail -n 2 /tmp/static.log');
    session.handleKey(key('Enter'));
    await flush();

    expect(lineTexts(session).some((t) => t.includes('two'))).toBe(true);
    expect(lineTexts(session).some((t) => t.includes('three'))).toBe(true);

    vfs.writeFile('/tmp/static.log', '+more\n', 0, 0, 0o022, true);
    await flush();
    expect(lineTexts(session).some((t) => t.includes('+more'))).toBe(false);
  });
});
