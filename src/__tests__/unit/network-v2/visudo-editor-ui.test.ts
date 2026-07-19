/**
 * `visudo` (no -c) — interactive editor UI flow.
 *
 * Real visudo edits a temp copy of /etc/sudoers (or -f target) and only
 * installs it if the saved content parses cleanly — /etc/sudoers must
 * never be left syntactically broken, since that locks every admin out
 * of sudo. Mirrors the existing `crontab -e` editor UI test
 * (cron-editor-ui.test.ts) for the harness pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let srv: LinuxServer;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  srv = new LinuxServer('linux-server', 'SRV1', 0, 0);
  srv.powerOn();
  session = new LinuxTerminalSession('term-1', srv);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

describe('visudo — editor UI flow', () => {
  it('opens the editor on a temp buffer seeded with the current /etc/sudoers content', async () => {
    await type('visudo');
    expect(session.inputMode.type).toBe('editor');
    const mode = session.inputMode as { content: string; filePath: string };
    expect(mode.content).toContain('root ALL=(ALL:ALL) ALL');
    expect(mode.filePath).toMatch(/\/tmp\/visudo\./);
  });

  it('saving valid content installs it into /etc/sudoers', async () => {
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('root ALL=(ALL:ALL) ALL\ndeploy ALL=(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    const sudoers = await srv.executeCommand('cat /etc/sudoers');
    expect(sudoers).toContain('deploy ALL=(ALL) NOPASSWD: ALL');
  });

  it('saving syntactically invalid content triggers the real "What now?" recovery prompt, not a silent discard', async () => {
    const before = await srv.executeCommand('cat /etc/sudoers');
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('deploy ALL(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    // Real visudo never silently discards a rejected save — it drops back
    // to a recovery prompt with the file still untouched until the user
    // chooses what to do next.
    const after = await srv.executeCommand('cat /etc/sudoers');
    expect(after).toBe(before);
    expect(session.inputMode.type).toBe('normal'); // no full-screen editor — this is a plain prompt
    expect(session.lines.some((l) => l.text.includes('syntax error'))).toBe(true);
    expect(session.lines.some((l) => l.text === 'What now?')).toBe(true);
    expect(session.lines.some((l) => l.text.includes('(e)dit sudoers file again'))).toBe(true);
    expect(session.lines.some((l) => l.text.includes('unchanged'))).toBe(false); // not yet — no answer given

    await type('x');
    expect(session.lines.some((l) => l.text.includes('unchanged'))).toBe(true);
  });

  it('"What now?" (e) re-opens the editor on the same temp buffer, preserving the invalid content', async () => {
    await type('visudo');
    const mode1 = session.inputMode as { absolutePath: string };
    session.editorSave('deploy ALL(ALL) NOPASSWD: ALL\n', mode1.absolutePath);
    session.editorExit(true);
    await flush();
    expect(session.inputMode.type).toBe('normal');

    await type('e');
    expect(session.inputMode.type).toBe('editor');
    const mode2 = session.inputMode as { content: string; absolutePath: string };
    expect(mode2.content).toBe('deploy ALL(ALL) NOPASSWD: ALL\n');
    expect(mode2.absolutePath).toBe(mode1.absolutePath); // same temp file, not a new one

    session.editorSave('deploy ALL=(ALL) NOPASSWD: ALL\n', mode2.absolutePath);
    session.editorExit(true);
    await flush();
    expect(await srv.executeCommand('cat /etc/sudoers')).toContain('deploy ALL=(ALL) NOPASSWD: ALL');
  });

  it('"What now?" (x) exits without saving — /etc/sudoers stays untouched', async () => {
    const before = await srv.executeCommand('cat /etc/sudoers');
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('deploy ALL(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    await type('x');
    expect(await srv.executeCommand('cat /etc/sudoers')).toBe(before);
    expect(session.lines.some((l) => l.text.includes('unchanged'))).toBe(true);
  });

  it('"What now?" (Q) force-saves the syntactically broken content anyway, with a DANGER warning', async () => {
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('deploy ALL(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    await type('Q');
    const after = await srv.executeCommand('cat /etc/sudoers');
    expect(after).toBe('deploy ALL(ALL) NOPASSWD: ALL');
    expect(session.lines.some((l) => l.text.includes('DANGER'))).toBe(true);
  });

  it('an unrecognized answer re-prints the "What now?" menu instead of silently proceeding', async () => {
    await type('visudo');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('deploy ALL(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    await type('zzz');
    expect(session.inputMode.type).toBe('normal'); // still stuck at the prompt
    const whatNowCount = session.lines.filter((l) => l.text === 'What now?').length;
    expect(whatNowCount).toBe(2); // printed once on rejection, once more after the bad answer

    await type('x'); // still answerable afterwards
    expect(session.lines.some((l) => l.text.includes('unchanged'))).toBe(true);
  });

  it('aborting the editor leaves /etc/sudoers unchanged', async () => {
    const before = await srv.executeCommand('cat /etc/sudoers');
    await type('visudo');
    session.editorExit(false);
    await flush();

    const after = await srv.executeCommand('cat /etc/sudoers');
    expect(after).toBe(before);
    expect(session.lines.some((l) => l.text.includes('no changes made'))).toBe(true);
  });

  it('visudo -f edits a different target file, not /etc/sudoers', async () => {
    await srv.executeCommand('mkdir -p /etc/sudoers.d');
    await type('visudo -f /etc/sudoers.d/deploy');
    const mode = session.inputMode as { absolutePath: string };
    expect(mode.absolutePath).toMatch(/\/tmp\/visudo\./);

    session.editorSave('deploy ALL=(ALL) NOPASSWD: ALL\n', mode.absolutePath);
    session.editorExit(true);
    await flush();

    expect(await srv.executeCommand('cat /etc/sudoers.d/deploy')).toContain('deploy ALL=(ALL) NOPASSWD: ALL');
    expect(await srv.executeCommand('cat /etc/sudoers')).not.toContain('deploy ALL=(ALL) NOPASSWD: ALL');
  });

  it('a non-root, non-sudo user cannot run visudo', async () => {
    EquipmentRegistry.resetInstance();
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const pcSession = new LinuxTerminalSession('term-2', pc);
    pcSession.setInput('visudo');
    pcSession.handleKey(key('Enter'));
    await flush();

    expect(pcSession.inputMode.type).toBe('normal');
    expect(pcSession.lines.some((l) => l.text.includes('must be root'))).toBe(true);
  });

  it('a user who elevated via "sudo su -" in this session CAN run visudo (session-scoped, not device-global)', async () => {
    EquipmentRegistry.resetInstance();
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();
    const pcSession = new LinuxTerminalSession('term-3', pc);
    pcSession.setInput('sudo su -');
    pcSession.handleKey(key('Enter'));
    await flush();
    expect(pcSession.currentInputMode.type).toBe('password');
    pcSession.insertText('admin');
    pcSession.handleKey(key('Enter'));
    await flush();

    pcSession.setInput('visudo');
    pcSession.handleKey(key('Enter'));
    await flush();

    expect(pcSession.inputMode.type).toBe('editor');
    expect(pcSession.lines.some((l) => l.text.includes('must be root'))).toBe(false);
  });

  it('visudo -c still runs the (non-editor) syntax check path', async () => {
    await type('visudo -c');
    expect(session.inputMode.type).toBe('normal');
    expect(session.lines.some((l) => l.text.includes('parsed OK'))).toBe(true);
  });
});
