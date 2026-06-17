import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

describe('crontab -e — editor UI flow', () => {
  it('CU-01 opens the editor on a temp buffer seeded with a template', async () => {
    await type('crontab -e');
    expect(session.inputMode.type).toBe('editor');
    const mode = session.inputMode as { content: string; filePath: string };
    expect(mode.content).toContain('Edit this file to introduce tasks');
    expect(mode.filePath).toMatch(/\/tmp\/crontab\./);
  });

  it('CU-02 saving the editor installs the new crontab', async () => {
    await type('crontab -e');
    const mode = session.inputMode as { absolutePath: string };
    session.editorSave('* * * * * /bin/from-editor\n', mode.absolutePath);
    session.editorExit(true);
    await flush();
    expect(await pc.executeCommand('crontab -l')).toContain('/bin/from-editor');
    expect(session.lines.some((l) => l.text.includes('installing new crontab'))).toBe(true);
  });

  it('CU-03 aborting the editor leaves the crontab unchanged', async () => {
    await pc.executeCommand('echo "0 0 * * * /bin/keep" | crontab -');
    await type('crontab -e');
    session.editorExit(false);
    await flush();
    expect(session.lines.some((l) => l.text.includes('no changes made to crontab'))).toBe(true);
    expect(await pc.executeCommand('crontab -l')).toContain('/bin/keep');
  });

  it('CU-04 editing an existing crontab seeds the editor with its content', async () => {
    await pc.executeCommand('echo "30 4 * * * /bin/existing" | crontab -');
    await type('crontab -e');
    const mode = session.inputMode as { content: string };
    expect(mode.content).toContain('/bin/existing');
  });

  it('CU-05 a non-root user cannot edit another user via -u', async () => {
    await type('crontab -u root -e');
    expect(session.inputMode.type).toBe('normal');
    expect(session.lines.some((l) => l.text.includes('must be privileged'))).toBe(true);
  });
});
