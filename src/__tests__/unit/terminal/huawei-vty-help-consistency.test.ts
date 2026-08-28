/**
 * Huawei `?` inline help must read the PER-VTY mode, exactly like Tab
 * completion and the prompt already do.
 *
 * Bug found via live UX exploration (Playwright): `HuaweiTerminalSession`
 * overrides `resolveCliTabCandidates`, `updatePrompt` and `executeOnDevice`
 * to route through the vty-aware `Router`/`Switch` methods
 * (`cliTabCandidatesForVty`, `getPromptForVty`, `executeCommandInVty`), but
 * never overrode `resolveCliHelp` — so `?` fell back to the device's
 * SHARED (non-per-vty) shell state. Symptom: right after `system-view`,
 * `interface ?` answered "Error: Unrecognized command" even though the
 * prompt correctly showed `[Router1]` and Tab-completion on the exact same
 * input correctly listed the live interfaces.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function screen(session: HuaweiTerminalSession): string {
  return session.lines.map((l) => (typeof l === 'string' ? l : (l as { text?: string }).text ?? '')).join('\n');
}

describe('Huawei router `?` help follows the per-vty mode', () => {
  it('`interface ?` right after `system-view` lists the real interfaces, not "Unrecognized command"', async () => {
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.resetInstance();
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const router = new HuaweiRouter('H1');
    router.setEventBus(bus);
    const sid = manager.openTerminal(router)!;
    const session = manager.getSession(sid) as HuaweiTerminalSession;
    await waitBoot(session);

    session.setInput('system-view');
    session.handleKey(key('Enter'));
    await flush();

    session.setInput('interface ');
    session.handleKey(key('?'));
    await flush();

    const out = screen(session);
    expect(out).not.toContain('Unrecognized command');
    expect(out).toMatch(/GigabitEthernet|GE\d/);
  });

  it('two concurrent terminals on the same router each get help for THEIR OWN mode', async () => {
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.resetInstance();
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const router = new HuaweiRouter('H1');
    router.setEventBus(bus);

    const sidA = manager.openTerminal(router)!;
    const a = manager.getSession(sidA) as HuaweiTerminalSession;
    await waitBoot(a);
    const sidB = manager.openTerminal(router, 'vty')!;
    const b = manager.getSession(sidB) as HuaweiTerminalSession;
    await waitBoot(b);

    // Terminal A enters system-view; terminal B stays at user view.
    a.setInput('system-view');
    a.handleKey(key('Enter'));
    await flush();

    // B, still at user view, asks for help on a user-view-only command.
    b.setInput('');
    b.handleKey(key('?'));
    await flush();
    const bOut = screen(b);
    // Le MOT-CLE, pas le texte : `interface` figure legitimement dans la
    // description de `free` (« Release a user terminal interface »), et
    // chercher la sous-chaine faisait echouer ce controle sur une phrase
    // au lieu d'une commande. Un mot-cle est ce qui ouvre une ligne.
    const motsCles = bOut.split('\n')
      .map((l) => /^\s\s(\S+)/.exec(l)?.[1]).filter(Boolean);
    expect(motsCles).not.toContain('interface');

    // A, in system-view, still sees interface help correctly.
    a.setInput('interface ');
    a.handleKey(key('?'));
    await flush();
    const aOut = screen(a);
    expect(aOut).not.toContain('Unrecognized command');
  });
});

describe('Huawei switch `?` help follows the per-vty mode', () => {
  it('`interface ?` right after `system-view` lists the real ports', async () => {
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.resetInstance();
    EquipmentRegistry.getInstance().setEventBus(bus);
    const manager = new TerminalManager(bus);
    const sw = new HuaweiSwitch('switch-huawei', 'SW1');
    sw.setEventBus(bus);
    const sid = manager.openTerminal(sw)!;
    const session = manager.getSession(sid) as HuaweiTerminalSession;
    await waitBoot(session);

    session.setInput('system-view');
    session.handleKey(key('Enter'));
    await flush();

    session.setInput('interface ');
    session.handleKey(key('?'));
    await flush();

    const out = screen(session);
    expect(out).not.toContain('Unrecognized command');
    expect(out).toMatch(/GigabitEthernet|GE\d/);
  });
});
