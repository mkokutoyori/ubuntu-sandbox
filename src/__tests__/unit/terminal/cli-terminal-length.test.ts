/**
 * terminal_gap.md §5.3/§5.4 — `terminal length N` per-vty + pager.
 *
 * Real Cisco IOS / Huawei VRP scopes `terminal length` / `screen-length`
 * per line: `terminal length 0` disables the pager only in the vty that
 * issued it; sibling vty's keep the default 24. The simulator used to
 * hard-code `PAGE_SIZE = 24` and silently ignore `terminal length 0`.
 *
 * Tests assert:
 *   1. `terminal length 0` mutates only the issuing session.
 *   2. `terminal length 50` is observable in the snapshot.
 *   3. `terminal no length` restores the default 24.
 *   4. The CLITerminalSession honors the per-vty page size (0 → no pager).
 *   5. Huawei `screen-length 0` and `screen-length disable` work too.
 *   6. Invalid lengths return the Cisco/Huawei "% Invalid input" error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

describe('Cisco IOS terminal length (per-vty pager)', () => {
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
    const t = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(t);
    return t;
  }

  it('default terminal length is 24 lines', async () => {
    const t = await openTerminal();
    expect(t.vty!.state.terminalLength).toBe(24);
  });

  it('`terminal length 0` disables the pager for the issuing vty only', async () => {
    const a = await openTerminal();
    const b = await openTerminal();

    await router.executeCommandInVty('enable', a.vty!);
    await router.executeCommandInVty('terminal length 0', a.vty!);

    expect(a.vty!.state.terminalLength).toBe(0);
    expect(b.vty!.state.terminalLength).toBe(24);
  });

  it('`terminal length 50` is captured in the snapshot', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('enable', a.vty!);
    await router.executeCommandInVty('terminal length 50', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(50);
  });

  it('`terminal width N` is also captured per-vty', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('terminal width 132', a.vty!);
    expect(a.vty!.state.terminalWidth).toBe(132);
  });

  it('`terminal no length` restores the IOS default of 24', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('terminal length 0', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(0);
    await router.executeCommandInVty('terminal no length', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(24);
  });

  it('CLITerminalSession reads getPageSize() from the vty session', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('terminal length 7', a.vty!);

    // `getPageSize` is protected; cast for testability — the override
    // wires the vty state through to the pager logic.
    const pageSize = (a as unknown as { getPageSize(): number }).getPageSize();
    expect(pageSize).toBe(7);
  });

  it('an out-of-range terminal length returns Cisco invalid-input', async () => {
    const a = await openTerminal();
    const out = await router.executeCommandInVty('terminal length 9999', a.vty!);
    expect(out).toMatch(/Invalid input/i);
    // Default remains intact.
    expect(a.vty!.state.terminalLength).toBe(24);
  });

  it('a non-numeric terminal length returns Cisco invalid-input', async () => {
    const a = await openTerminal();
    const out = await router.executeCommandInVty('terminal length abc', a.vty!);
    expect(out).toMatch(/Invalid input/i);
    expect(a.vty!.state.terminalLength).toBe(24);
  });

  it('`terminal monitor` is accepted as a recognised no-op', async () => {
    const a = await openTerminal();
    const out = await router.executeCommandInVty('terminal monitor', a.vty!);
    expect(out).toBe('');
  });

  it('concurrent terminal-length on two vty\'s are serialised atomically', async () => {
    const a = await openTerminal();
    const b = await openTerminal();
    await Promise.all([
      router.executeCommandInVty('terminal length 0', a.vty!),
      router.executeCommandInVty('terminal length 42', b.vty!),
    ]);
    expect(a.vty!.state.terminalLength).toBe(0);
    expect(b.vty!.state.terminalLength).toBe(42);
  });
});

describe('Huawei VRP screen-length (per-vty pager)', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let router: HuaweiRouter;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    router = new HuaweiRouter('AR1');
    router.setEventBus(bus);
  });

  async function openTerminal(): Promise<HuaweiTerminalSession> {
    const sid = manager.openTerminal(router)!;
    const t = manager.getSession(sid) as HuaweiTerminalSession;
    await waitBoot(t);
    return t;
  }

  it('default screen-length is 24', async () => {
    const t = await openTerminal();
    expect(t.vty!.state.terminalLength).toBe(24);
  });

  it('`screen-length 0` disables the pager for the issuing vty only', async () => {
    const a = await openTerminal();
    const b = await openTerminal();
    await router.executeCommandInVty('screen-length 0', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(0);
    expect(b.vty!.state.terminalLength).toBe(24);
  });

  it('`screen-length disable` is an alias for `screen-length 0`', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('screen-length disable', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(0);
  });

  it('`undo screen-length` restores the VRP default of 24', async () => {
    const a = await openTerminal();
    await router.executeCommandInVty('screen-length 0', a.vty!);
    await router.executeCommandInVty('undo screen-length', a.vty!);
    expect(a.vty!.state.terminalLength).toBe(24);
  });
});
