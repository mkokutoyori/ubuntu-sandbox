import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

async function waitBoot(session: HuaweiTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Huawei VRP terminal monitor — syslog event subscription streams into the vty', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: HuaweiRouter;
  let session: HuaweiTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new HuaweiRouter('R1');
    router.setEventBus(bus);
    const sid = manager.openTerminal(router)!;
    session = manager.getSession(sid) as HuaweiTerminalSession;
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
        deviceId: router.id,
        iface: 'GigabitEthernet0/0/0',
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

    expect(session.lines.some((l) => l.text.includes('2.2.2.2') && /OSPF/i.test(l.text))).toBe(true);
  });

  it('the prompt stays free while monitor runs (background, not blocking)', async () => {
    await type('terminal monitor');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('a session without terminal monitor sees nothing', async () => {
    adjChange();
    await flush();
    expect(session.lines.some((l) => /OSPF/.test(l.text) && l.text.includes('2.2.2.2'))).toBe(false);
  });

  it('undo terminal monitor stops the subscription — further events are silent', async () => {
    await type('terminal monitor');
    adjChange();
    await flush();
    const count = session.lines.filter((l) => /OSPF/.test(l.text) && l.text.includes('2.2.2.2')).length;
    expect(count).toBe(1);

    await type('undo terminal monitor');
    expect(session.vty!.state.terminalMonitor).toBe(false);
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    adjChange();
    await flush();
    expect(session.lines.filter((l) => /OSPF/.test(l.text) && l.text.includes('2.2.2.2')).length).toBe(count);
  });

  it('two sessions are isolated — only the one with terminal monitor streams', async () => {
    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as HuaweiTerminalSession;
    await waitBoot(session2);

    await type('terminal monitor');
    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('2.2.2.2') && /OSPF/.test(l.text))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('2.2.2.2') && /OSPF/.test(l.text))).toBe(false);
  });

  it('terminal debugging and terminal monitor reconcile independently', async () => {
    await type('terminal monitor');
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal monitor')).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal debugging')).toBe(false);

    await type('debugging ospf event');
    await type('terminal debugging');
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal debugging')).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal monitor')).toBe(true);

    await type('undo terminal debugging');
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal debugging')).toBe(false);
    expect(session.listAsyncJobs().some((j) => j.command === 'terminal monitor')).toBe(true);
  });
});
