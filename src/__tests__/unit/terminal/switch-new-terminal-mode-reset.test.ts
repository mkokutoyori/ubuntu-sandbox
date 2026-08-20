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

describe('a new switch terminal starts in user mode, not the last terminal\'s mode', () => {
  let bus: EventBus;
  let manager: TerminalManager;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
  });

  it('Cisco switch: closing a terminal left in config-if mode does not leak into the next terminal', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    sw.setEventBus(bus);

    const sid1 = manager.openTerminal(sw)!;
    const t1 = manager.getSession(sid1) as CiscoTerminalSession;
    await waitBoot(t1);
    await sw.executeCommandInVty('enable', t1.vty!);
    await sw.executeCommandInVty('configure terminal', t1.vty!);
    await sw.executeCommandInVty('interface FastEthernet0/1', t1.vty!);
    expect(sw.getPromptForVty(t1.vty!)).toBe('SW1(config-if)#');
    manager.closeTerminal(sid1);

    const sid2 = manager.openTerminal(sw)!;
    const t2 = manager.getSession(sid2) as CiscoTerminalSession;
    await waitBoot(t2);
    expect(sw.getPromptForVty(t2.vty!)).toBe('SW1>');
  });

  it('Huawei switch: closing a terminal left in interface view does not leak into the next terminal', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.setEventBus(bus);

    const sid1 = manager.openTerminal(sw)!;
    const t1 = manager.getSession(sid1) as HuaweiTerminalSession;
    await waitBoot(t1);
    await sw.executeCommandInVty('system-view', t1.vty!);
    await sw.executeCommandInVty('interface GigabitEthernet0/0/1', t1.vty!);
    expect(sw.getPromptForVty(t1.vty!)).toBe('[SW1-GigabitEthernet0/0/1]');
    manager.closeTerminal(sid1);

    const sid2 = manager.openTerminal(sw)!;
    const t2 = manager.getSession(sid2) as HuaweiTerminalSession;
    await waitBoot(t2);
    expect(sw.getPromptForVty(t2.vty!)).toBe('<SW1>');
  });
});
