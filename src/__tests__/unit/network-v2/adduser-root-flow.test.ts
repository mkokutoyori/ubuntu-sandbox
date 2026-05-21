/**
 * adduser interactive flow for a root terminal — regression test.
 *
 * Bug: `su`/`sudo -s` push a frame onto the *per-terminal* shell session,
 * but `LinuxTerminalSession.startInteractiveFlow` read the *device-wide*
 * current user. After `su root` a terminal was therefore mis-classified as
 * non-root, so `adduser` skipped its password / GECOS interactive flow and
 * created the account silently.
 *
 * Fix: `startInteractiveFlow` reads the per-terminal shell session's
 * user/uid. These tests drive a real terminal session and assert that
 * `adduser` becomes interactive once the terminal is root.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── Helpers ────────────────────────────────────────────────────────────

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/** Type a command line in normal (bash) mode and submit it. */
async function typeCommand(session: LinuxTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

/** Submit a password while the terminal is in password-input mode. */
async function typePassword(session: LinuxTerminalSession, pw: string): Promise<void> {
  session.setPasswordBuf(pw);
  session.handleKey(key('Enter'));
  await flush();
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('adduser interactive flow — root terminal', () => {
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
  });

  it('prompts for a password after `su root` then `adduser` on a PC', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-1', pc);

    // Elevate this terminal to root via `su` (root password is "admin").
    await typeCommand(session, 'su');
    expect(session.currentInputMode.type).toBe('password');
    await typePassword(session, 'admin');

    // The terminal is now root. `adduser` must drive the interactive flow.
    await typeCommand(session, 'adduser bob');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('collects the GECOS fields after the password on a root PC terminal', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-1', pc);

    await typeCommand(session, 'su');
    await typePassword(session, 'admin');
    await typeCommand(session, 'adduser bob');

    // New password → retype → then the GECOS finger prompts.
    expect(session.currentInputMode.type).toBe('password');
    await typePassword(session, 'bobsecret');
    await typePassword(session, 'bobsecret');
    expect(session.currentInputMode.type).toBe('interactive-text');
  });

  it('is interactive for `adduser` on a server terminal (root by default)', async () => {
    const srv = new LinuxServer('linux-server', 'SRV1');
    const session = new LinuxTerminalSession('term-1', srv);

    await typeCommand(session, 'adduser carol');
    expect(session.currentInputMode.type).toBe('password');
  });

  it('still runs `adduser` non-interactively for a non-root terminal', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const session = new LinuxTerminalSession('term-1', pc);

    // Default user is the unprivileged `user` — no flow, `adduser` is
    // rejected by the executor (root-only command).
    await typeCommand(session, 'adduser bob');
    expect(session.currentInputMode.type).toBe('normal');
  });
});
