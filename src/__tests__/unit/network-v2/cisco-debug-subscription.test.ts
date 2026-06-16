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

describe('Cisco debug ip ospf — event subscription streams into the terminal', () => {
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

  async function enableOspf(): Promise<void> {
    await router.executeCommandInVty('enable', session.vty!);
    await router.executeCommandInVty('configure terminal', session.vty!);
    await router.executeCommandInVty('router ospf 1', session.vty!);
    await router.executeCommandInVty('network 10.0.0.0 0.0.0.255 area 0', session.vty!);
    await router.executeCommandInVty('end', session.vty!);
  }

  function adjChange(): void {
    bus.publish({
      topic: 'ospf.neighbor.state-changed',
      payload: {
        routerId: '1.1.1.1',
        processId: 1,
        deviceId: router.id,
        iface: 'GigabitEthernet0/0',
        neighborId: '2.2.2.2',
        oldState: 'Loading',
        newState: 'Full',
        event: 'LoadingDone',
      },
    });
  }

  it('streams a live ADJCHG line once debug is enabled', async () => {
    await enableOspf();
    await type('debug ip ospf adj');

    expect(session.hasBackgroundAsyncJobs).toBe(true);
    expect(session.listAsyncJobs().some((j) => j.kind === 'subscription')).toBe(true);

    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('ADJCHG') && l.text.includes('Full'))).toBe(true);
  });

  it('the prompt stays free while debug runs (background, not blocking)', async () => {
    await enableOspf();
    await type('debug ip ospf adj');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
  });

  it('no debug stops the subscription — further events are silent', async () => {
    await enableOspf();
    await type('debug ip ospf adj');
    adjChange();
    await flush();
    const count = session.lines.filter((l) => l.text.includes('ADJCHG')).length;
    expect(count).toBe(1);

    await type('no debug ip ospf adj');
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    adjChange();
    await flush();
    expect(session.lines.filter((l) => l.text.includes('ADJCHG')).length).toBe(count);
  });

  it('sessions are isolated — a second terminal without debug sees nothing', async () => {
    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    await waitBoot(session2);

    await enableOspf();
    await type('debug ip ospf adj');
    adjChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('ADJCHG'))).toBe(true);
    expect(session2.lines.some((l) => l.text.includes('ADJCHG'))).toBe(false);
  });
});
