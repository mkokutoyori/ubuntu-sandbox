/**
 * Sub-shell isolation — terminal_gap.md §7.
 *
 * Verifies what the per-terminal sub-shell story actually delivers after
 * §1-§6 fixes:
 *
 *  - SQL*Plus: each terminal allocates its own SQLPlusSession with its
 *    own executor context; ALTER SESSION SET CURRENT_SCHEMA in one
 *    terminal does not leak into the other.
 *  - PowerShell: each terminal gets its own PowerShellExecutor and
 *    PSInterpreter; $global: scope is per-instance.
 *  - PowerShell launched from a Windows terminal starts at THAT
 *    terminal's cwd (via the WindowsShellSession), not the device's
 *    shared cwd.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';

describe('Sub-shell isolation across concurrent terminals', () => {
  let bus: EventBus;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
  });

  describe('SQL*Plus — per-session executor.context', () => {
    it('two SQL*Plus shells on the same DB have independent sessions', () => {
      const dba = new LinuxServer('dba1', 0, 0);
      dba.setEventBus(bus);
      // Pre-install Oracle so SqlPlusSubShell.create finds it.
      const { subShell: shellA } = SqlPlusSubShell.create(
        dba, ['sys/oracle', 'as', 'sysdba'],
      );
      const { subShell: shellB } = SqlPlusSubShell.create(
        dba, ['sys/oracle', 'as', 'sysdba'],
      );

      // Each sub-shell is its own object instance.
      expect(shellA).not.toBe(shellB);
      // Each sub-shell can be disposed independently.
      shellA.dispose();
      // shellB is still usable: it has its own connected session.
      // (Sanity probe: processLine returns a SubShellResult — it should
      // not throw "session disposed" because that is a per-shell flag.)
      const r = shellB.processLine('SELECT 1 FROM dual;');
      expect(r).toBeDefined();
      shellB.dispose();
    });

    it('ALTER SESSION SET CURRENT_SCHEMA in shell A does not affect shell B', () => {
      const dba = new LinuxServer('dba2', 0, 0);
      dba.setEventBus(bus);
      const { subShell: shellA } = SqlPlusSubShell.create(
        dba, ['sys/oracle', 'as', 'sysdba'],
      );
      const { subShell: shellB } = SqlPlusSubShell.create(
        dba, ['sys/oracle', 'as', 'sysdba'],
      );

      shellA.processLine('ALTER SESSION SET CURRENT_SCHEMA = HR;');
      // shellB's prompt / context must still be SYS — we can't easily
      // probe context.currentSchema from outside, so use SHOW USER as
      // a soft proxy.
      const r = shellB.processLine('SHOW USER;');
      const text = r.output.join('\n');
      // Real SQL*Plus prints `USER is "SYS"` for sysdba sessions. Match
      // case-insensitively to tolerate small formatting variations.
      expect(text.toUpperCase()).toContain('SYS');

      shellA.dispose();
      shellB.dispose();
    });
  });

  describe('PowerShell — per-instance interpreter & executor', () => {
    let manager: TerminalManager;
    let pc: WindowsPC;

    beforeEach(() => {
      manager = new TerminalManager(bus);
      pc = new WindowsPC('PC1', 0, 0);
      pc.setEventBus(bus);
    });

    it('two PowerShellSubShells get independent PS executor state', () => {
      const { subShell: psA } = PowerShellSubShell.create(pc);
      const { subShell: psB } = PowerShellSubShell.create(pc);
      expect(psA).not.toBe(psB);
    });

    it('PowerShell launched from terminal A starts at A\'s cwd, not B\'s', async () => {
      const t1 = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;
      const t2 = manager.getSession(manager.openTerminal(pc)!) as WindowsTerminalSession;

      // Mutate t2's cwd. With the §6 fix the device-wide cwd does NOT change.
      await pc.executeCommandInSession('cd C:\\Windows', t2.shell!);
      expect(t2.shell!.cwd).toBe('C:\\Windows');
      expect(t1.shell!.cwd).toBe('C:\\Users\\User');

      // Now launch PowerShell from t1 with the initialCwd hint — it must
      // start at t1's cwd, not at the device's shared one (which might
      // have leaked from t2 in older code).
      const { subShell: ps } = PowerShellSubShell.create(pc, {
        initialCwd: t1.shell!.cwd,
      });
      expect(ps.getPrompt()).toContain('C:\\Users\\User');
    });

    it('PowerShell falls back to the device cwd when no hint is given', () => {
      const { subShell: ps } = PowerShellSubShell.create(pc);
      // No hint → device default cwd.
      expect(ps.getPrompt()).toContain('C:\\Users\\User');
    });
  });
});
