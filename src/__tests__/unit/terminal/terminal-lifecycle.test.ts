/**
 * Terminal lifecycle reactivity tests.
 *
 * Verifies that the TerminalManager reacts to Equipment domain events
 * published on the EventBus, rather than relying on imperative cleanup.
 *
 * Covers the three lifecycle anomalies fixed in Section 1 of
 * terminal_gap.md:
 *   1. Deleting a device closes its terminals (device.removed event).
 *   2. Powering a device off freezes its terminals (device.power-off).
 *   3. Powering it back on unfreezes them (device.power-on).
 *   4. Clearing the registry disposes every session (registry.cleared).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';

describe('Terminal lifecycle — bus-driven cleanup', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    pc = new LinuxPC('pc1', 0, 0);
    pc.setEventBus(bus);
  });

  it('opens a terminal on a powered-on device', () => {
    const sid = manager.openTerminal(pc);
    expect(sid).not.toBeNull();
    expect(manager.size).toBe(1);
    expect(manager.hasTerminal(pc.getId())).toBe(true);
  });

  it('refuses to open a terminal on a powered-off device', () => {
    pc.powerOff();
    const sid = manager.openTerminal(pc);
    expect(sid).toBeNull();
    expect(manager.size).toBe(0);
  });

  it('freezes terminals when the device powers off', () => {
    const sid = manager.openTerminal(pc)!;
    const session = manager.getSession(sid)!;
    expect(session.isDisconnected).toBe(false);

    pc.powerOff();

    expect(session.isDisconnected).toBe(true);
    expect(session.inputMode).toMatchObject({ type: 'disconnected' });
    // Scrollback must be preserved, with a notice line appended.
    const lastLine = session.lines[session.lines.length - 1];
    expect(lastLine.text).toMatch(/Connection to .* lost/);
  });

  it('unfreezes terminals on power back on', () => {
    const sid = manager.openTerminal(pc)!;
    const session = manager.getSession(sid)!;
    pc.powerOff();
    expect(session.isDisconnected).toBe(true);

    pc.powerOn();
    expect(session.isDisconnected).toBe(false);
    expect(session.inputMode.type).toBe('normal');
  });

  it('disposes terminals when the device is deregistered', () => {
    const sid = manager.openTerminal(pc)!;
    expect(manager.size).toBe(1);

    EquipmentRegistry.getInstance().deregister(pc.getId());

    expect(manager.size).toBe(0);
    expect(manager.getSession(sid)).toBeUndefined();
  });

  it('disposes ALL terminals when the registry is cleared', () => {
    const pc2 = new LinuxPC('pc2', 0, 0);
    pc2.setEventBus(bus);
    manager.openTerminal(pc);
    manager.openTerminal(pc2);
    expect(manager.size).toBe(2);

    EquipmentRegistry.getInstance().clear();

    expect(manager.size).toBe(0);
  });

  it('survives multiple terminals on the same device — closes all on remove', () => {
    const sid1 = manager.openTerminal(pc)!;
    const sid2 = manager.openTerminal(pc)!;
    expect(manager.getSessionsForDevice(pc.getId())).toHaveLength(2);

    EquipmentRegistry.getInstance().deregister(pc.getId());

    expect(manager.getSession(sid1)).toBeUndefined();
    expect(manager.getSession(sid2)).toBeUndefined();
    expect(manager.hasTerminal(pc.getId())).toBe(false);
  });

  it('exposes registerTearDown for SSH / sub-shell cleanup', () => {
    const sid = manager.openTerminal(pc)!;
    const session = manager.getSession(sid)!;
    const calls: string[] = [];
    session.registerTearDown(() => calls.push('a'));
    session.registerTearDown(() => calls.push('b'));

    manager.closeTerminal(sid);

    expect(calls).toEqual(['a', 'b']);
  });

  it('runs tear-downs immediately when registered after dispose', () => {
    const sid = manager.openTerminal(pc)!;
    const session = manager.getSession(sid)!;
    manager.closeTerminal(sid);

    let ran = false;
    session.registerTearDown(() => { ran = true; });
    expect(ran).toBe(true);
  });

  it('input handling is no-op while disconnected', () => {
    const sid = manager.openTerminal(pc)!;
    const session = manager.getSession(sid)!;
    pc.powerOff();
    expect(session.isDisconnected).toBe(true);

    const consumed = session.handleKey({
      key: 'a', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    });
    // We swallow keys while disconnected so the view never advances state.
    expect(consumed).toBe(true);
  });
});
