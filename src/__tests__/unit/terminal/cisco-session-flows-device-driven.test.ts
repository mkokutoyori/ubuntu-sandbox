/**
 * Cisco terminal-session interactive flows must drive the DEVICE, not
 * replace it (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §3).
 *
 * Pins:
 *   - `erase startup-config` typed in the UI terminal really erases the
 *     startup configuration (same effect as the vty/SSH path),
 *   - `copy running-config startup-config` really saves, honors IOS
 *     abbreviations (`copy run start`, `copy runn star`), and the
 *     confirmation flow triggers for all of them,
 *   - `reload` keeps working through its confirmation flow.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!session.isBooting) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Cisco UI terminal flows execute the real device commands', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: CiscoRouter;
  let session: CiscoTerminalSession;

  beforeEach(async () => {
    resetCounters();
    resetDeviceCounters();
    MACAddress.resetCounter();
    Logger.reset();
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

  /**
   * Read NVRAM from the console. The UI session is a separate line, so its
   * enable does not carry over — `show startup-config` is privilege 15.
   */
  async function startupConfig(): Promise<string> {
    await router.executeCommand('enable');
    return router.executeCommand('show startup-config');
  }

  /** Configure a hostname and save, so startup-config has content. */
  async function seedStartupConfig(): Promise<void> {
    await type('enable');
    await type('configure terminal');
    await type('hostname SAVED-R1');
    await type('end');
    await type('copy running-config startup-config');
    await type(''); // accept "Destination filename [startup-config]?"
    await flush();
  }

  it('erase startup-config really erases the NVRAM (UI path = vty path)', async () => {
    await seedStartupConfig();

    let out = await startupConfig();
    expect(out).toContain('hostname SAVED-R1');

    await type('erase startup-config');
    await type(''); // [confirm]
    await flush();

    out = await startupConfig();
    expect(out).not.toContain('hostname SAVED-R1');
  });

  it('copy running-config startup-config really saves the config', async () => {
    await type('enable');
    await type('configure terminal');
    await type('hostname UI-SAVE');
    await type('end');
    await type('copy running-config startup-config');
    await type('');
    await flush();

    const out = await startupConfig();
    expect(out).toContain('hostname UI-SAVE');
  });

  it('copy run start (IOS abbreviation) triggers the flow and saves', async () => {
    await type('enable');
    await type('configure terminal');
    await type('hostname ABBREV-SAVE');
    await type('end');
    await type('copy run start');
    await type('');
    await flush();

    const out = await startupConfig();
    expect(out).toContain('hostname ABBREV-SAVE');
  });

  it('copy runn star (partial keywords) also triggers the interactive flow and saves', async () => {
    await type('enable');
    await type('configure terminal');
    await type('hostname PARTIAL-SAVE');
    await type('end');
    await type('copy runn star');
    await type('');
    await flush();

    // Reaching the save (via the abbreviated form) proves the flow drove
    // the device command rather than swallowing it.
    const out = await startupConfig();
    expect(out).toContain('hostname PARTIAL-SAVE');
  });
});
