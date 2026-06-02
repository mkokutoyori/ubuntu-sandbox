import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>(r => setTimeout(r, 5));

function setup() {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  const session = new LinuxTerminalSession('term-1', pc);
  const exec = (pc as unknown as { executor: { vfs: { writeFile(p: string, c: string, u: number, g: number, m: number, a?: boolean): boolean } } }).executor;
  return { pc, session, exec };
}

describe('tail -f goes through the unified attachStream pipeline', () => {
  it('registers a stream attachment while tail -f runs and Ctrl+C detaches it', async () => {
    const { session, exec } = setup();
    exec.vfs.writeFile('/var/log/syslog', 'seed\n', 0, 0, 0o022);

    session.setInput('tail -f /var/log/syslog');
    session.handleKey(key('Enter'));
    await flush();

    const before = session.listAttachedStreams();
    expect(before.length).toBe(1);
    expect(before[0].description).toContain('tail -f');
    expect(before[0].active).toBe(true);

    exec.vfs.writeFile('/var/log/syslog', 'live-line\n', 0, 0, 0o022, true);
    await flush();
    expect(session.lines.some(l => l.text.includes('live-line'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();

    const after = session.listAttachedStreams();
    expect(after.length).toBe(0);
    expect(before[0].active).toBe(false);
    expect(session.lines.some(l => l.text === '^C')).toBe(true);
  });
});
