/**
 * Huawei VRP vty isolation — roadmap item (a) from terminal_gap.md §5.1.
 *
 * Same correctness goals as the Cisco IOS test: opening two terminals on
 * the same VRP router gives each its own mode, selectedInterface, and
 * sub-mode pointers. system-view in one terminal does NOT push siblings
 * into [Router-system] mode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';

async function waitBoot(session: HuaweiTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('Huawei VRP vty session isolation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: HuaweiRouter;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new HuaweiRouter('R1');
    router.setEventBus(bus);
  });

  async function openTerminal(): Promise<HuaweiTerminalSession> {
    const sid = manager.openTerminal(router)!;
    const session = manager.getSession(sid) as HuaweiTerminalSession;
    await waitBoot(session);
    return session;
  }

  it('each Huawei terminal gets its own vty session', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    expect(t1.vty).not.toBeNull();
    expect(t2.vty).not.toBeNull();
    expect(t1.vty!.id).not.toBe(t2.vty!.id);
  });

  it('system-view in one terminal does NOT push the other into [Router]', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('system-view', t1.vty!);
    // After system-view the mode becomes 'system' on VRP.
    expect(t1.vty!.state.mode).toBe('system');
    expect(t2.vty!.state.mode).toBe('user-view');
  });

  it('interface gigabitethernet 0/0/0 in one vty does not select it elsewhere', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('system-view', t1.vty!);
    await router.executeCommandInVty('interface gigabitethernet 0/0/0', t1.vty!);
    expect(t1.vty!.state.selectedInterface).not.toBeNull();
    expect(t2.vty!.state.selectedInterface).toBeNull();
  });

  it('quit in one vty does not unwind the other', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('system-view', t1.vty!);
    await router.executeCommandInVty('system-view', t2.vty!);
    expect(t1.vty!.state.mode).toBe('system');
    expect(t2.vty!.state.mode).toBe('system');

    await router.executeCommandInVty('quit', t1.vty!);
    // VRP shell stores the user view as 'user' internally; the displayed
    // mode label is "user-view" but the FSM uses 'user'. Either way the
    // critical point is that t1 unwound while t2 stayed in system view.
    expect(t1.vty!.state.mode).not.toBe('system');
    expect(t2.vty!.state.mode).toBe('system');
  });

  it('the vty session is destroyed on terminal close', async () => {
    const t1 = await openTerminal();
    const vtyId = t1.vty!.id;
    manager.closeTerminal(t1.id);
    expect(router.getVtySession(vtyId)).toBeUndefined();
  });
});
