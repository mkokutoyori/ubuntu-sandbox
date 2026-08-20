/**
 * Huawei VRP terminal-session flows must drive the DEVICE, not replace it
 * (IoC refactor — audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §3).
 *
 * Before the refactor the UI `save` flow printed "[OK]" without saving
 * anything and `reset saved-configuration` cleared nothing. Now the flow is
 * declared by the VRP shell and its run steps execute the real commands.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

async function waitBoot(session: HuaweiTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Huawei UI terminal flows execute the real device commands', () => {
  let session: HuaweiTerminalSession;
  let router: HuaweiRouter;

  beforeEach(async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    router = new HuaweiRouter('H1');
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

  it('save through the UI really persists (display saved-configuration sees it)', async () => {
    await type('system-view');
    await type('sysname UI-VRP-SAVE');
    await type('quit');
    await type('save');
    await type('y'); // Are you sure to continue? [Y/N]
    await flush();

    const saved = await router.executeCommand('display saved-configuration');
    expect(saved).toContain('UI-VRP-SAVE');
  });

  it('reset saved-configuration through the UI really clears the saved config', async () => {
    await type('system-view');
    await type('sysname UI-VRP-RESET');
    await type('quit');
    await type('save');
    await type('y');
    await flush();
    expect(await router.executeCommand('display saved-configuration')).toContain('UI-VRP-RESET');

    await type('reset saved-configuration');
    await type('y');
    await flush();

    expect(await router.executeCommand('display saved-configuration')).not.toContain('UI-VRP-RESET');
  });
});
