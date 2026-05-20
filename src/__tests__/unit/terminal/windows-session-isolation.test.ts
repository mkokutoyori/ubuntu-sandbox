/**
 * Windows shell session isolation — terminal_gap.md §6.
 *
 * Same correctness goals as §2 but applied to cmd.exe. Two terminals on
 * the same WindowsPC must observe independent cwd / env / history.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';

describe('Windows cmd.exe shell session isolation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let pc: WindowsPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
    pc = new WindowsPC('PC1', 0, 0);
    pc.setEventBus(bus);
  });

  function openTerminal(): WindowsTerminalSession {
    const sid = manager.openTerminal(pc)!;
    return manager.getSession(sid)! as WindowsTerminalSession;
  }

  it('each terminal gets its own cmd.exe session with %USERPROFILE% cwd', () => {
    const t1 = openTerminal();
    const t2 = openTerminal();
    expect(t1.shell).not.toBeNull();
    expect(t2.shell).not.toBeNull();
    expect(t1.shell!.id).not.toBe(t2.shell!.id);
    expect(t1.shell!.cwd).toBe('C:\\Users\\User');
    expect(t2.shell!.cwd).toBe('C:\\Users\\User');
  });

  it('cd in one terminal does NOT change the prompt of the other', async () => {
    const t1 = openTerminal();
    const t2 = openTerminal();
    await pc.executeCommandInSession('cd C:\\Windows', t1.shell!);
    expect(t1.shell!.cwd).toBe('C:\\Windows');
    expect(t2.shell!.cwd).toBe('C:\\Users\\User');

    // Prompt reflects per-session state, not the device-wide cwd.
    expect(t1.getPrompt()).toBe('C:\\Windows>');
    expect(t2.getPrompt()).toBe('C:\\Users\\User>');
  });

  it('opening a fresh terminal does not inherit another terminal\'s cwd', async () => {
    const t1 = openTerminal();
    await pc.executeCommandInSession('cd C:\\Windows', t1.shell!);
    expect(t1.shell!.cwd).toBe('C:\\Windows');

    const t2 = openTerminal();
    expect(t2.shell!.cwd).toBe('C:\\Users\\User');
  });

  it('set in one terminal does not leak into the other', async () => {
    const t1 = openTerminal();
    const t2 = openTerminal();
    await pc.executeCommandInSession('set FOO=hello', t1.shell!);
    expect(t1.shell!.env.get('FOO')).toBe('hello');
    expect(t2.shell!.env.has('FOO')).toBe(false);
  });

  it('closing one terminal preserves the other\'s state', async () => {
    const t1 = openTerminal();
    const t2 = openTerminal();
    await pc.executeCommandInSession('cd C:\\Windows', t2.shell!);
    expect(t2.shell!.cwd).toBe('C:\\Windows');

    manager.closeTerminal(t1.id);
    expect(t2.shell).not.toBeNull();
    expect(t2.shell!.cwd).toBe('C:\\Windows');
  });

  it('serialises concurrent commands so the swap window is atomic', async () => {
    const t1 = openTerminal();
    const t2 = openTerminal();
    const [r1, r2] = await Promise.all([
      pc.executeCommandInSession('cd C:\\Windows', t1.shell!),
      pc.executeCommandInSession('cd C:\\Users', t2.shell!),
    ]);
    // Whatever the order of completion, the final per-session cwd must
    // match the command issued from that session — never the other.
    expect(t1.shell!.cwd).toBe('C:\\Windows');
    expect(t2.shell!.cwd).toBe('C:\\Users');
    // Sanity: commands ran (no thrown error). Outputs may be empty for cd.
    void r1; void r2;
  });

  it('the per-session drive cwd map tracks the active drive', async () => {
    const t1 = openTerminal();
    await pc.executeCommandInSession('cd C:\\Windows', t1.shell!);
    expect(t1.shell!.driveCwd.get('C')).toBe('C:\\Windows');
  });

  it('the shell is disposed on terminal close', () => {
    const t1 = openTerminal();
    const shell = t1.shell!;
    manager.closeTerminal(t1.id);
    expect(shell.disposed).toBe(true);
    expect(pc.getShellSession(shell.id)).toBeUndefined();
  });
});
