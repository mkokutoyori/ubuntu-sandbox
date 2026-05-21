/**
 * terminal_gap.md §7.x — PowerShell native delegations honour the
 * owning terminal's session cwd.
 *
 * Before this fix, PowerShellExecutor's `executeCmdCommand(...)` calls
 * (ipconfig / ping / cd / dir / …) all read `WindowsPC.cwd`, the
 * device-wide field shared between every open terminal. So opening
 * PowerShell from terminal A while terminal B's cmd shell had done
 * `cd D:\foo` displayed `PS D:\foo>` in A — wrong.
 *
 * PowerShellSubShell now holds a reference to the owning
 * WindowsShellSession and dispatches every line via
 * `WindowsPC.runInSession(session, fn)`. Inside that callback,
 * `device.getCwd()` returns the session's cwd, and any cmd-delegated
 * filesystem command resolves relative paths from the session's cwd.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('PowerShell sub-shell uses owner session cwd', () => {
  let bus: EventBus;
  let pc: WindowsPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new WindowsPC('PC1', 0, 0);
    pc.setEventBus(bus);
    const fs = pc.getFileSystem();
    fs.mkdirp('C:\\projects\\alpha');
    fs.mkdirp('C:\\projects\\beta');
  });

  it('PowerShell launched from terminal A starts at A\'s cwd, not the device\'s', async () => {
    const shellA = pc.openShellSession();
    const shellB = pc.openShellSession();

    // Terminal B mutates the device-wide cwd via the swap window.
    await pc.executeCommandInSession('cd C:\\projects\\beta', shellB);

    // A's session cwd is untouched (USERPROFILE default).
    expect(shellA.cwd).toBe('C:\\Users\\User');

    // Launch PowerShell on top of A.
    const { subShell: ps } = PowerShellSubShell.create(pc, {
      initialCwd: shellA.cwd,
      session: shellA,
    });

    expect(ps.getPrompt()).toContain('C:\\Users\\User');
  });

  it('`cd C:\\projects\\alpha` inside PS mutates the session, not the device-wide cwd', async () => {
    const shellA = pc.openShellSession();
    const shellB = pc.openShellSession();

    const { subShell: psA } = PowerShellSubShell.create(pc, {
      initialCwd: shellA.cwd,
      session: shellA,
    });

    await psA.processLine('cd C:\\projects\\alpha');

    expect(shellA.cwd).toBe('C:\\projects\\alpha');
    expect(shellB.cwd).toBe('C:\\Users\\User');
  });

  it('two PS sub-shells on the same device observe independent cwds', async () => {
    const shellA = pc.openShellSession();
    const shellB = pc.openShellSession();

    const { subShell: psA } = PowerShellSubShell.create(pc, {
      initialCwd: shellA.cwd, session: shellA,
    });
    const { subShell: psB } = PowerShellSubShell.create(pc, {
      initialCwd: shellB.cwd, session: shellB,
    });

    await psA.processLine('cd C:\\projects\\alpha');
    await psB.processLine('cd C:\\projects\\beta');

    expect(psA.getPrompt()).toContain('alpha');
    expect(psB.getPrompt()).toContain('beta');

    expect(shellA.cwd).toBe('C:\\projects\\alpha');
    expect(shellB.cwd).toBe('C:\\projects\\beta');
  });

  it('without a session reference, PS still falls back to device cwd (backwards compat)', async () => {
    pc.setCwd('C:\\projects\\alpha');
    const { subShell: ps } = PowerShellSubShell.create(pc);
    expect(ps.getPrompt()).toContain('C:\\projects\\alpha');
  });

  it('concurrent processLine on two PS sub-shells stays isolated', async () => {
    const shellA = pc.openShellSession();
    const shellB = pc.openShellSession();

    const { subShell: psA } = PowerShellSubShell.create(pc, {
      initialCwd: shellA.cwd, session: shellA,
    });
    const { subShell: psB } = PowerShellSubShell.create(pc, {
      initialCwd: shellB.cwd, session: shellB,
    });

    await Promise.all([
      psA.processLine('cd C:\\projects\\alpha'),
      psB.processLine('cd C:\\projects\\beta'),
    ]);

    // Serialisation guarantee: each terminal ends up at exactly its
    // requested cwd, not crossed.
    expect(shellA.cwd).toBe('C:\\projects\\alpha');
    expect(shellB.cwd).toBe('C:\\projects\\beta');
  });
});
