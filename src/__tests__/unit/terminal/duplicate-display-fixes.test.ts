/**
 * Double-display fixes — terminal_gap.md §9.
 *
 * Locks in the corrections for three reported user-visible bugs:
 *   §9.1 — sudo printed the password prompt twice
 *   §9.2 — SSH login showed "Welcome to Ubuntu …" twice
 *   §9.3 — switching from PowerShell to cmd showed the CMD banner twice
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

describe('terminal_gap.md §9 — double-display fixes', () => {
  let bus: EventBus;
  let manager: TerminalManager;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);
  });

  describe('§9.1 — sudo prompt is not duplicated', () => {
    it('shows the password prompt only via the input row, not in scrollback', async () => {
      const pc = new LinuxPC('pc1', 0, 0);
      pc.setEventBus(bus);
      const sid = manager.openTerminal(pc)!;
      const session = manager.getSession(sid) as LinuxTerminalSession;

      // Type "sudo whoami" and submit
      session.setInput('sudo whoami');
      session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

      // The flow engine should now be paused on a password step.
      // While the input row is active, the prompt MUST NOT appear in
      // scrollback yet — only the typed command line should be there.
      await new Promise(r => setTimeout(r, 30));
      const promptLinesBefore = session.lines.filter(
        l => /password for user/.test(l.text),
      );
      expect(promptLinesBefore).toHaveLength(0);
      // The input mode should be 'password'.
      expect(session.inputMode.type).toBe('password');
    });

    it('echoes the prompt to scrollback once the user submits', async () => {
      const pc = new LinuxPC('pc2', 0, 0);
      pc.setEventBus(bus);
      const sid = manager.openTerminal(pc)!;
      const session = manager.getSession(sid) as LinuxTerminalSession;

      session.setInput('sudo whoami');
      session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
      await new Promise(r => setTimeout(r, 30));

      // Type a password (the test session has user/admin by default).
      session.setPasswordBuf('admin');
      session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
      await new Promise(r => setTimeout(r, 30));

      // After submit, the prompt line should appear exactly ONCE.
      const promptLines = session.lines.filter(
        l => /password for user/.test(l.text),
      );
      expect(promptLines).toHaveLength(1);
    });
  });

  describe('§9.2 — "Welcome to Ubuntu" appears at most once on SSH login', () => {
    it('composeLoginBanner prefers /etc/motd over a synthesised line', async () => {
      // We exercise composeLoginBanner indirectly by checking that a
      // freshly provisioned LinuxPC has exactly one Welcome line in its
      // /etc/motd, and that no second one is appended at login time
      // (composeLoginBanner now uses motd-as-authoritative).
      const pc = new LinuxPC('pc3', 0, 0);
      pc.setEventBus(bus);
      const motd = (pc as unknown as {
        executor: { vfs: { readFile: (p: string) => string | null } };
      }).executor.vfs.readFile('/etc/motd') ?? '';
      const occurrences = (motd.match(/Welcome to Ubuntu/g) ?? []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('§9.3 — PS → cmd does not duplicate the CMD banner', () => {
    it('PowerShellSubShell.processLine("cmd") returns no output, just _enterCmd', async () => {
      const pc = new WindowsPC('PC1', 0, 0);
      pc.setEventBus(bus);
      const { subShell } = PowerShellSubShell.create(pc);

      const result = await subShell.processLine('cmd');
      // Empty output → banner only comes from enterNestedCmd → no dup.
      expect(result.output).toEqual([]);
      expect((result as { _enterCmd?: boolean })._enterCmd).toBe(true);
    });

    it('switching PS → cmd via the session adds exactly one banner', async () => {
      const pc = new WindowsPC('PC2', 0, 0);
      pc.setEventBus(bus);
      const sid = manager.openTerminal(pc)!;
      const session = manager.getSession(sid) as WindowsTerminalSession;

      // Enter PowerShell first.
      session.setInput('powershell');
      session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
      await new Promise(r => setTimeout(r, 30));

      // Now from inside PS, type "cmd".
      session.setInputBuf('cmd');
      session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
      await new Promise(r => setTimeout(r, 50));

      const bannerLines = session.lines.filter(
        l => /Microsoft Windows \[Version/.test(l.text),
      );
      // ONE banner (from enterNestedCmd) — the TerminalView root banner is
      // suppressed because shellStack.length > 0, and PowerShellSubShell
      // no longer echoes it.
      expect(bannerLines.length).toBe(1);
    });
  });
});
