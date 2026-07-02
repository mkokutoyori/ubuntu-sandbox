import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Cisco switch debug spanning-tree — event subscription on the async pipeline', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let sw: CiscoSwitch;
  let session: CiscoTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    sw = new CiscoSwitch('SW1');
    sw.setEventBus(bus);
    const sid = manager.openTerminal(sw)!;
    session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  function stateChange(): void {
    bus.publish({
      topic: 'stp.state.changed',
      payload: {
        deviceId: sw.id,
        hostname: 'SW1',
        port: 'FastEthernet0/2',
        oldState: 'blocking',
        newState: 'forwarding',
      },
    });
  }

  it('streams a live STP state-change line once debug is enabled, prompt free', async () => {
    await type('enable');
    await type('debug spanning-tree events');

    expect(session.hasBackgroundAsyncJobs).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);

    stateChange();
    await flush();

    expect(session.lines.some((l) => l.text.includes('STP:') && l.text.includes('forwarding'))).toBe(true);
  });

  it('no debug spanning-tree stops the subscription', async () => {
    await type('enable');
    await type('debug spanning-tree events');
    stateChange();
    await flush();
    const count = session.lines.filter((l) => l.text.includes('STP:')).length;
    expect(count).toBe(1);

    await type('no debug spanning-tree');
    expect(session.hasBackgroundAsyncJobs).toBe(false);

    stateChange();
    await flush();
    expect(session.lines.filter((l) => l.text.includes('STP:')).length).toBe(count);
  });
});
