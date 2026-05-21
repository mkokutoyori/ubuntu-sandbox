/**
 * vty session isolation — terminal_gap.md §5.1.
 *
 * Real Cisco IOS / Huawei VRP keeps one console + 5 vty lines, each with
 * its own privilege level, mode, selectedInterface, terminalLength, etc.
 * `enable` in one vty does NOT elevate the others. The simulator used to
 * collapse all that onto a single shell instance shared across terminals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('Cisco IOS vty session isolation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: CiscoRouter;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new CiscoRouter('R1');
    router.setEventBus(bus);
  });

  async function openTerminal(): Promise<CiscoTerminalSession> {
    const sid = manager.openTerminal(router)!;
    const session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
    return session;
  }

  it('each terminal gets its own vty session', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    expect(t1.vty).not.toBeNull();
    expect(t2.vty).not.toBeNull();
    expect(t1.vty!.id).not.toBe(t2.vty!.id);
  });

  it('both terminals start in user mode', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    // The default Cisco IOS prompt for user mode is "R1>"
    expect(t1.vty!.state.mode).toBe('user');
    expect(t2.vty!.state.mode).toBe('user');
  });

  it('enable in one terminal does NOT elevate the other', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();

    // Drive t1 to privileged mode via the device API.
    await router.executeCommandInVty('enable', t1.vty!);
    expect(t1.vty!.state.mode).toBe('privileged');
    // The OTHER terminal must still be in user mode.
    expect(t2.vty!.state.mode).toBe('user');
  });

  it('configure terminal in one vty does not push another into config', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('enable', t1.vty!);
    await router.executeCommandInVty('configure terminal', t1.vty!);
    expect(t1.vty!.state.mode).toBe('config');
    expect(t2.vty!.state.mode).toBe('user');
  });

  it('interface selection is per-vty', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('enable', t1.vty!);
    await router.executeCommandInVty('configure terminal', t1.vty!);
    await router.executeCommandInVty('interface gi0/0', t1.vty!);
    // Cisco IOS expands "gi0/0" → "GigabitEthernet0/0" canonical form.
    expect(t1.vty!.state.selectedInterface).toBe('GigabitEthernet0/0');
    expect(t2.vty!.state.selectedInterface).toBeNull();
  });

  it('exit in one terminal does not unwind the other\'s mode', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('enable', t1.vty!);
    await router.executeCommandInVty('enable', t2.vty!);
    expect(t1.vty!.state.mode).toBe('privileged');
    expect(t2.vty!.state.mode).toBe('privileged');

    await router.executeCommandInVty('disable', t1.vty!);
    expect(t1.vty!.state.mode).toBe('user');
    expect(t2.vty!.state.mode).toBe('privileged');
  });

  it('closes the vty session on terminal close', async () => {
    const t1 = await openTerminal();
    const vtyId = t1.vty!.id;
    manager.closeTerminal(t1.id);
    expect(router.getVtySession(vtyId)).toBeUndefined();
  });

  it('the prompt rendered for one terminal reflects its own mode', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await router.executeCommandInVty('enable', t1.vty!);
    // Force the per-vty prompt path.
    const p1 = router.getPromptForVty(t1.vty!);
    const p2 = router.getPromptForVty(t2.vty!);
    expect(p1).toMatch(/#$/);  // privileged
    expect(p2).toMatch(/>$/);  // user
  });

  it('concurrent commands across vty\'s are serialised atomically', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    const [_a, _b] = await Promise.all([
      router.executeCommandInVty('enable', t1.vty!),
      router.executeCommandInVty('enable', t2.vty!),
    ]);
    expect(t1.vty!.state.mode).toBe('privileged');
    expect(t2.vty!.state.mode).toBe('privileged');
    // And the privilege levels are tracked per-session.
    expect(t1.vty!.state.privilegeLevel).toBe(15);
    expect(t2.vty!.state.privilegeLevel).toBe(15);
  });
});
