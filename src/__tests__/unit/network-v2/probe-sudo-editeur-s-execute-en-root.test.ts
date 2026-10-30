/**
 * `sudo nano|vi|vim <file>` runs the editor as root.
 *
 * Measured before the fix: the terminal stripped the `sudo` prefix and opened
 * the editor with the invoking user's identity, so no password was asked and
 * a write to a root-owned file ended in `E212` / a permission error.
 *
 * Discriminated with `git stash push -- src/terminal`: 3 of the 6 cases fall
 * before the fix ("asks the sudo password", "writes a root-owned file as
 * root", "a wrong password opens no editor"). The other 3 pass either way and
 * are named for what they are: the unprivileged write refusal is the WITNESS
 * that the lab's file really is protected; "the identity returns to the user"
 * and "plain nano still opens without a prompt" are non-regressions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function typeCommand(session: LinuxTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

async function typePassword(session: LinuxTerminalSession, pw: string): Promise<void> {
  session.setPasswordBuf(pw);
  session.handleKey(key('Enter'));
  await flush();
}

let pc: LinuxPC;
let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1');
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('sudo <editor> runs the editor as root', () => {
  it('asks the sudo password before opening the editor', async () => {
    await typeCommand(session, 'sudo nano /etc/probe.conf');
    expect(session.currentInputMode.type).toBe('password');
    await typePassword(session, 'admin');
    expect(session.currentInputMode.type).toBe('editor');
  });

  it('writes a root-owned file as root', async () => {
    await typeCommand(session, 'sudo nano /etc/probe.conf');
    await typePassword(session, 'admin');
    const mode = session.currentInputMode as { absolutePath: string };
    session.editorSave('probe=1\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    expect(await pc.executeCommand('cat /etc/probe.conf')).toContain('probe=1');
    expect(await pc.executeCommand('stat -c %U /etc/probe.conf')).toContain('root');
  });

  it('a wrong password opens no editor', async () => {
    await typeCommand(session, 'sudo nano /etc/probe.conf');
    await typePassword(session, 'wrong');
    await typePassword(session, 'wrong');
    await typePassword(session, 'wrong');
    expect(session.currentInputMode.type).not.toBe('editor');
  });

  it('WITNESS: without sudo the same write is refused', async () => {
    await typeCommand(session, 'nano /etc/probe.conf');
    const mode = session.currentInputMode as { absolutePath: string };
    session.editorSave('probe=1\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    expect(await pc.executeCommand('cat /etc/probe.conf')).not.toContain('probe=1');
  });

  it('NON-REGRESSION: the identity returns to the user once the editor exits', async () => {
    await typeCommand(session, 'sudo vim /etc/probe.conf');
    await typePassword(session, 'admin');
    session.editorExit(false);
    await flush();

    await typeCommand(session, 'whoami');
    expect(session.lines.map((l) => l.text).join('\n')).toMatch(/\buser\b/);
    expect(session.lines.at(-2)?.text).not.toBe('root');
  });

  it('NON-REGRESSION: plain nano still opens without a prompt', async () => {
    await typeCommand(session, 'nano /tmp/probe.txt');
    expect(session.currentInputMode.type).toBe('editor');
  });
});
