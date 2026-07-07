import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';

async function waitBoot(session: TerminalSession): Promise<void> {
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
    await waitBoot(manager.getSession(sid1)!);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    expect(sw.getPrompt()).toBe('SW1(config-if)#');
    manager.closeTerminal(sid1);

    const sid2 = manager.openTerminal(sw)!;
    const t2 = manager.getSession(sid2)!;
    await waitBoot(t2);
    expect(sw.getPrompt()).toBe('SW1>');
  });

  it('Huawei switch: closing a terminal left in interface view does not leak into the next terminal', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.setEventBus(bus);

    const sid1 = manager.openTerminal(sw)!;
    await waitBoot(manager.getSession(sid1)!);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    expect(sw.getPrompt()).toBe('[SW1-GigabitEthernet0/0/1]');
    manager.closeTerminal(sid1);

    const sid2 = manager.openTerminal(sw)!;
    const t2 = manager.getSession(sid2)!;
    await waitBoot(t2);
    expect(sw.getPrompt()).toBe('<SW1>');
  });
});
