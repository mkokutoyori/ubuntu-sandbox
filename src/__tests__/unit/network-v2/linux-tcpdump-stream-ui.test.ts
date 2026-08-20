import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 15));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}
function capture(pc: LinuxPC, srcPort: number, dstPort: number): void {
  (pc as unknown as { executor: { captureLog: { capture(p: object): void } } }).executor.captureLog.capture({
    at: new Date(), srcIp: '10.0.0.1', srcPort, dstIp: '10.0.0.2', dstPort, flags: 'S', seq: 0, ack: 0, length: 0,
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

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

describe('Linux tcpdump — live capture streaming', () => {
  it('TD-01 streams the header, locks the prompt, streams live packets, Ctrl+C prints the summary', async () => {
    await type('tcpdump');
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);
    expect(texts(session).some((t) => t.includes('listening on eth0'))).toBe(true);

    capture(pc, 1234, 80);
    await waitFor(session, (l) => l.some((t) => t.includes('10.0.0.1.1234 > 10.0.0.2.80')));
    expect(texts(session).some((t) => t.includes('Flags [S]'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('1 packet captured'))).toBe(true);
  });

  it('TD-02 -c stops after the requested number of packets', async () => {
    await type('tcpdump -c 2');
    capture(pc, 1, 22);
    capture(pc, 2, 22);
    await waitFor(session, (l) => l.some((t) => t.includes('2 packets captured')));
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).filter((t) => t.includes('Flags [S]')).length).toBe(2);
  });

  it('TD-03 a port filter only streams matching packets', async () => {
    await type('tcpdump port 22');
    capture(pc, 5555, 80);
    capture(pc, 6666, 22);
    await waitFor(session, (l) => l.some((t) => t.includes('.6666 > 10.0.0.2.22')));
    expect(texts(session).some((t) => t.includes('.5555 > '))).toBe(false);
    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(texts(session).some((t) => t.includes('1 packet captured'))).toBe(true);
  });

  it('TD-04 non-tcpdump and piped tcpdump fall through (no streaming job)', async () => {
    await type('tcpdump -c 1 | grep x');
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});
