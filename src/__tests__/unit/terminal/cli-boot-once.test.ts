/**
 * Boot-once behaviour for CLI terminals — terminal_gap.md §5.2.
 *
 * Real Cisco IOS / Huawei VRP: plugging a console (or opening a vty) on
 * an already-running device shows just the prompt — never the "System
 * Bootstrap, Version 15.2…" banner. Only a real power-cycle replays it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';

async function flushBoot(session: CiscoTerminalSession): Promise<void> {
  // CLI init renders the boot text via setTimeout(...,12). Wait long enough
  // to cover the worst case (a typical Cisco boot text has ~30 lines).
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('CLI boot banner replay policy', () => {
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

  it('the FIRST session shows the boot banner', async () => {
    const sid = manager.openTerminal(router)!;
    const session = manager.getSession(sid) as CiscoTerminalSession;
    await flushBoot(session);
    expect(router.hasBootBeenShown()).toBe(true);
    // At least one 'boot'-typed line was emitted.
    const bootLines = session.lines.filter(l => l.type === 'boot');
    expect(bootLines.length).toBeGreaterThan(0);
  });

  it('a SECOND session opened on the same running device skips boot', async () => {
    const sid1 = manager.openTerminal(router)!;
    await flushBoot(manager.getSession(sid1) as CiscoTerminalSession);

    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    // Second session must NOT have any boot-typed lines.
    expect(session2.isBooting).toBe(false);
    const bootLines = session2.lines.filter(l => l.type === 'boot');
    expect(bootLines.length).toBe(0);
  });

  it('a real power-cycle replays the boot banner on the next session', async () => {
    const sid1 = manager.openTerminal(router)!;
    await flushBoot(manager.getSession(sid1) as CiscoTerminalSession);

    router.powerOff();
    expect(router.hasBootBeenShown()).toBe(false);
    router.powerOn();
    expect(router.hasBootBeenShown()).toBe(false);

    const sid2 = manager.openTerminal(router)!;
    const session2 = manager.getSession(sid2) as CiscoTerminalSession;
    await flushBoot(session2);
    const bootLines = session2.lines.filter(l => l.type === 'boot');
    expect(bootLines.length).toBeGreaterThan(0);
  });
});
