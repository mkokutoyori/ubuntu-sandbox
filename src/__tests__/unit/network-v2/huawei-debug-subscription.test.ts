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

describe('Huawei VRP debugging ospf — event subscription streams into the terminal', () => {
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
        oldState: 'Init',
        newState: '2WAY',
        event: 'HelloReceived',
      },
    });
  }

  it('streams a VRP-format Neighbor state change once both debug + terminal debugging are on', async () => {
    await type('debugging ospf event');
    await type('terminal debugging');

    expect(session.hasBackgroundAsyncJobs).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.kind === 'subscription')).toBe(true);

    adjChange();
    await flush();

    expect(session.lines.some((l) =>
      l.text.includes('OSPF: Neighbor') && l.text.includes('Init -> 2WAY'))).toBe(true);
  });

  it('terminal debugging without any debug flag does not start the subscription', async () => {
    await type('terminal debugging');
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    adjChange();
    await flush();
    expect(session.lines.some((l) => l.text.includes('OSPF: Neighbor'))).toBe(false);
  });

  it('debug flag without terminal debugging does not stream lines to this vty', async () => {
    await type('debugging ospf event');
    expect(session.hasBackgroundAsyncJobs).toBe(false);
    adjChange();
    await flush();
    expect(session.lines.some((l) => l.text.includes('OSPF: Neighbor'))).toBe(false);
  });

  it('the prompt stays free while debug streams (background, not blocking)', async () => {
    await type('debugging ospf event');
    await type('terminal debugging');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('undo debugging all stops the subscription — further events are silent', async () => {
    await type('debugging ospf event');
    await type('terminal debugging');
    adjChange();
    await flush();
    const count = session.lines.filter((l) => l.text.includes('OSPF: Neighbor')).length;
    expect(count).toBe(1);

    await type('undo debugging all');
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    adjChange();
    await flush();
    expect(session.lines.filter((l) => l.text.includes('OSPF: Neighbor')).length).toBe(count);
  });

  it('undo terminal debugging cancels the subscription (debug flag stays on)', async () => {
    await type('debugging ospf event');
    await type('terminal debugging');
    expect(session.hasBackgroundAsyncJobs).toBe(true);
    await type('undo terminal debugging');
    expect(session.hasBackgroundAsyncJobs).toBe(false);
  });

  it('two sessions are isolated — only the one with terminal debugging streams', async () => {
    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as HuaweiTerminalSession;
    await waitBoot(session2);

    await type('debugging ospf event');
    await type('terminal debugging');
    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('OSPF: Neighbor'))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('OSPF: Neighbor'))).toBe(false);
  });

  it('display debugging reports the enabled flag', async () => {
    await type('debugging ospf event');
    await type('display debugging');
    expect(session.lines.some((l) => l.text === 'OSPF event debugging is on')).toBe(true);
  });
});
