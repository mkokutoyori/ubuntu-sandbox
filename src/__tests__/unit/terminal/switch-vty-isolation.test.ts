/**
 * vty session isolation for switches — mirrors cli-vty-isolation.test.ts
 * (Router), which fixed terminal_gap.md §5.1 for Cisco IOS / Huawei VRP
 * routers. Cisco/Huawei switch shells were still a single instance shared
 * across every open terminal: two terminals open on the same switch would
 * observe each other's mode / sub-mode pointers live, not just on a
 * freshly-opened terminal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';

async function waitBoot(session: { isBooting: boolean }): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('Cisco switch vty session isolation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let sw: CiscoSwitch;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    sw.setEventBus(bus);
  });

  async function openTerminal(): Promise<CiscoTerminalSession> {
    const sid = manager.openTerminal(sw)!;
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

  it('escalating to config-if in one terminal does not affect the other, even after Enter on an empty line', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();

    await sw.executeCommandInVty('enable', t1.vty!);
    await sw.executeCommandInVty('configure terminal', t1.vty!);
    await sw.executeCommandInVty('interface FastEthernet0/1', t1.vty!);
    expect(t1.vty!.state.mode).toBe('config-if');

    // Terminal B never ran a command of its own — an empty-line Enter must
    // simply redraw its own unchanged (user) prompt.
    const out = await sw.executeCommandInVty('', t2.vty!);
    expect(out).toBe('');
    expect(t2.vty!.state.mode).toBe('user');
    expect(sw.getPromptForVty(t2.vty!)).toBe('SW1>');
    expect(sw.getPromptForVty(t1.vty!)).toBe('SW1(config-if)#');
  });

  it('interface selection is per-vty', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();
    await sw.executeCommandInVty('enable', t1.vty!);
    await sw.executeCommandInVty('configure terminal', t1.vty!);
    await sw.executeCommandInVty('interface FastEthernet0/1', t1.vty!);
    expect(t1.vty!.state.selectedInterface).toBe('FastEthernet0/1');
    expect(t2.vty!.state.selectedInterface).toBeNull();
  });

  it('closing a terminal disposes its vty session', async () => {
    const t1 = await openTerminal();
    const vtyId = t1.vty!.id;
    manager.closeTerminal(t1.id);
    expect(sw.getVtySession(vtyId)).toBeUndefined();
  });

  it('a freshly-opened terminal always starts in user mode regardless of another open terminal\'s mode', async () => {
    const t1 = await openTerminal();
    await sw.executeCommandInVty('enable', t1.vty!);
    await sw.executeCommandInVty('configure terminal', t1.vty!);
    await sw.executeCommandInVty('interface FastEthernet0/1', t1.vty!);
    expect(t1.vty!.state.mode).toBe('config-if');

    const t2 = await openTerminal();
    expect(t2.vty!.state.mode).toBe('user');
    expect(sw.getPromptForVty(t2.vty!)).toBe('SW1>');
  });
});

describe('Huawei switch vty session isolation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let sw: HuaweiSwitch;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.setEventBus(bus);
  });

  async function openTerminal(): Promise<HuaweiTerminalSession> {
    const sid = manager.openTerminal(sw)!;
    const session = manager.getSession(sid) as HuaweiTerminalSession;
    await waitBoot(session);
    return session;
  }

  it('escalating into interface view in one terminal does not affect the other', async () => {
    const t1 = await openTerminal();
    const t2 = await openTerminal();

    await sw.executeCommandInVty('system-view', t1.vty!);
    await sw.executeCommandInVty('interface GigabitEthernet0/0/1', t1.vty!);
    expect(t1.vty!.state.mode).toBe('interface');

    const out = await sw.executeCommandInVty('', t2.vty!);
    expect(out).toBe('');
    expect(t2.vty!.state.mode).toBe('user');
    expect(sw.getPromptForVty(t2.vty!)).toBe('<SW1>');
    expect(sw.getPromptForVty(t1.vty!)).toBe('[SW1-GigabitEthernet0/0/1]');
  });

  it('a freshly-opened terminal always starts in user view regardless of another open terminal\'s mode', async () => {
    const t1 = await openTerminal();
    await sw.executeCommandInVty('system-view', t1.vty!);
    await sw.executeCommandInVty('interface GigabitEthernet0/0/1', t1.vty!);
    expect(t1.vty!.state.mode).toBe('interface');

    const t2 = await openTerminal();
    expect(t2.vty!.state.mode).toBe('user');
    expect(sw.getPromptForVty(t2.vty!)).toBe('<SW1>');
  });
});
