import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('Linux tcpdump — live foreground capture streamed into the terminal', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let pc: LinuxPC;
  let session: LinuxTerminalSession;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    pc = new LinuxPC('linux-pc', 'PC1');
    pc.setEventBus(bus);
    const sid = manager.openTerminal(pc)!;
    session = manager.getSession(sid) as LinuxTerminalSession;
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function echoSent(seq: number): void {
    bus.publish({
      topic: 'host.icmp.echo-sent',
      payload: { deviceId: pc.getId(), hostname: 'PC1', fromIp: '10.0.0.1', toIp: '10.0.0.2', id: 7, seq, ttl: 64, size: 64 },
    });
  }

  it('streams a live ICMP line and blocks the prompt while capturing', async () => {
    await type('sudo tcpdump -i eth0');

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.lines.some((l) => l.text.includes('listening on eth0'))).toBe(true);

    echoSent(1);
    await flush();

    expect(session.lines.some((l) =>
      l.text.includes('IP 10.0.0.1 > 10.0.0.2: ICMP echo request') && l.text.includes('seq 1'))).toBe(true);
  });

  it('non-root capture is denied with a realistic permission error', async () => {
    await type('tcpdump -i eth0');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.lines.some((l) => l.text.includes("You don't have permission to capture"))).toBe(true);
    expect(session.lines.some((l) => l.text.includes('Operation not permitted'))).toBe(true);
  });

  it('Ctrl+C stops the capture and prints the packet-count summary', async () => {
    await type('sudo tcpdump');
    echoSent(1);
    echoSent(2);
    await flush();

    session.handleKey(key('c', { ctrlKey: true }));
    await flush();

    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.lines.some((l) => l.text === '2 packets captured')).toBe(true);
    expect(session.lines.some((l) => l.text === '0 packets dropped by kernel')).toBe(true);
  });

  it('-c <count> stops automatically after N packets and frees the prompt', async () => {
    await type('sudo tcpdump -c 1');
    expect(session.hasForegroundAsyncJob).toBe(true);

    echoSent(1);
    await flush();

    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.lines.some((l) => l.text === '1 packet captured')).toBe(true);
  });

  it('sessions are isolated — a second terminal without tcpdump sees nothing', async () => {
    const sid2 = manager.openTerminal(pc)!;
    const session2 = manager.getSession(sid2) as LinuxTerminalSession;

    await type('sudo tcpdump');
    echoSent(1);
    await flush();

    expect(session.lines.some((l) => l.text.includes('ICMP echo request'))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('ICMP echo request'))).toBe(false);
  });
});
