import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Cisco terminal monitor — syslog event subscription streams into the terminal', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: CiscoRouter;
  let session: CiscoTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new CiscoRouter('R1');
    router.setEventBus(bus);
    const sid = manager.openTerminal(router)!;
    session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function adjChange(): void {
    bus.publish({
      topic: 'ospf.neighbor.state-changed',
      payload: {
        routerId: '1.1.1.1',
        processId: 1,
        deviceId: router.getId(),
        iface: 'GigabitEthernet0/0',
        neighborId: '2.2.2.2',
        oldState: 'Loading',
        newState: 'Full',
        event: 'LoadingDone',
      },
    });
  }

  it('streams a live syslog line once terminal monitor is enabled', async () => {
    await type('terminal monitor');

    expect(session.vty!.state.terminalMonitor).toBe(true);
    expect(session.hasBackgroundAsyncJobs).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal monitor')).toBe(true);

    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('%OSPF-5') && l.text.includes('2.2.2.2'))).toBe(true);
  });

  it('the prompt stays free while monitor runs (background, not blocking)', async () => {
    await type('terminal monitor');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('a session without terminal monitor sees nothing', async () => {
    adjChange();
    await flush();
    expect(session.lines.some((l) => l.text.includes('%OSPF-5'))).toBe(false);
  });

  it('terminal no monitor stops the subscription — further events are silent', async () => {
    await type('terminal monitor');
    adjChange();
    await flush();
    const count = session.lines.filter((l) => l.text.includes('%OSPF-5')).length;
    expect(count).toBe(1);

    await type('terminal no monitor');
    expect(session.vty!.state.terminalMonitor).toBe(false);
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    adjChange();
    await flush();
    expect(session.lines.filter((l) => l.text.includes('%OSPF-5')).length).toBe(count);
  });

  it('sessions are isolated — only the monitored terminal receives the stream', async () => {
    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    await waitBoot(session2);

    await type('terminal monitor');
    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('%OSPF-5'))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('%OSPF-5'))).toBe(false);
  });

  it('messages below the configured monitor severity are filtered out', async () => {
    const cfg = router.getLoggingConfig()!;
    cfg.monitorSeverity = 'errors';

    await type('terminal monitor');
    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('%OSPF-5'))).toBe(false);

    bus.publish({
      topic: 'port.link.down',
      payload: { deviceId: router.getId(), portName: 'GigabitEthernet0/0' },
    });
    await flush();
    expect(session.lines.some((l) => l.text.includes('%LINK-3') && l.text.includes('down'))).toBe(true);
  });
});
