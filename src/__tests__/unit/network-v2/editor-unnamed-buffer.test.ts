/**
 * `nano`/`vi`/`vim` invoked with NO filename argument. Two bugs shared
 * one root cause: `openEditor` always resolved SOME path even with no
 * argument.
 *
 * - nano hardcoded the literal string "New Buffer" as the file path, so
 *   ^O silently proposed writing a real file named exactly that in the
 *   cwd — real nano shows "New Buffer" only as a title-bar STATUS, the
 *   actual unnamed buffer has no path at all until Write Out names one.
 * - vi/vim passed '' through, which VFS.normalizePath collapses to the
 *   cwd's OWN directory path (no extra path segment to append) — :w
 *   would have targeted the directory itself.
 *
 * TDD: driven through the real LinuxTerminalSession.openEditor path
 * (not the headless engines directly), since the bug lived in how the
 * session resolved the (missing) filename before ever constructing an
 * engine.
 */
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

describe('Scénario — `nano` sans argument : buffer réellement sans nom, pas de fichier "New Buffer"', () => {
  it('filePath/absolutePath sont vides, pas la chaîne littérale "New Buffer"', async () => {
    await type('nano');
    const mode = session.inputMode as { filePath: string; absolutePath: string; isNewFile: boolean };
    expect(mode.filePath).toBe('');
    expect(mode.absolutePath).toBe('');
    expect(mode.isNewFile).toBe(true);
  });

  it('^O (Write Out) propose un nom VIDE, pas "New Buffer" pré-rempli', async () => {
    await type('nano');
    // Drive the headless engine directly through the session's editor state.
    const NanoEngineMod = await import('@/network/devices/linux/editors/NanoEngine');
    const LinuxEditorFsContextMod = await import('@/terminal/sessions/LinuxEditorFsContext');
    const fsCtx = new LinuxEditorFsContextMod.LinuxEditorFsContext(pc);
    const nano = new NanoEngineMod.NanoEngine(fsCtx, '', '', true, false);
    nano.applyKey({ key: 'o', ctrl: true, shift: false, alt: false });
    expect(nano.mode).toBe('save-prompt');
    expect(nano.saveFileName).toBe('');
  });

  it('aucun fichier nommé "New Buffer" n\'apparaît quelque part sur le disque après ouverture', async () => {
    await type('nano');
    const out = await pc.executeCommand('find / -iname "*New Buffer*" 2>/dev/null');
    expect(out.trim()).toBe('');
  });

  it('typer un vrai nom puis ^O l\'écrit à cet endroit, pas dans un fichier "New Buffer"', async () => {
    await type('nano');
    const NanoEngineMod = await import('@/network/devices/linux/editors/NanoEngine');
    const LinuxEditorFsContextMod = await import('@/terminal/sessions/LinuxEditorFsContext');
    const fsCtx = new LinuxEditorFsContextMod.LinuxEditorFsContext(pc);
    const nano = new NanoEngineMod.NanoEngine(fsCtx, '', '', true, false);
    for (const ch of 'hello') nano.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    nano.applyKey({ key: 'o', ctrl: true, shift: false, alt: false });
    for (const ch of '/tmp/real-name.txt') nano.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    nano.applyKey({ key: 'Enter', ctrl: false, shift: false, alt: false });
    expect(nano.statusMessage).toBe('[ Wrote 1 line ]');
    expect(fsCtx.readFile('/tmp/real-name.txt')).toBe('hello\n');
  });
});

describe('Scénario — `vim`/`vi` sans argument : buffer réellement sans nom, pas de collision avec le cwd', () => {
  it('filePath/absolutePath sont vides', async () => {
    await type('vim');
    const mode = session.inputMode as { filePath: string; absolutePath: string; isNewFile: boolean };
    expect(mode.filePath).toBe('');
    expect(mode.absolutePath).toBe('');
    expect(mode.isNewFile).toBe(true);
  });

  it(':w sans nom échoue avec E32, ne touche jamais le répertoire courant', async () => {
    const VimEngineMod = await import('@/network/devices/linux/editors/VimEngine');
    const LinuxEditorFsContextMod = await import('@/terminal/sessions/LinuxEditorFsContext');
    const fsCtx = new LinuxEditorFsContextMod.LinuxEditorFsContext(pc);
    const before = await pc.executeCommand('ls /home/user');
    const vim = new VimEngineMod.VimEngine(fsCtx, '', '', true, 'vim');
    vim.applyKey({ key: 'i', ctrl: false, shift: false, alt: false });
    for (const ch of 'hello') vim.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    vim.applyKey({ key: 'Escape', ctrl: false, shift: false, alt: false });
    for (const ch of ':w') vim.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    vim.applyKey({ key: 'Enter', ctrl: false, shift: false, alt: false });
    expect(vim.message).toBe('E32: No file name');
    const after = await pc.executeCommand('ls /home/user');
    expect(after).toBe(before); // the home directory itself was never touched
  });

  it(':w /tmp/real.txt (nom explicite) réussit normalement', async () => {
    const VimEngineMod = await import('@/network/devices/linux/editors/VimEngine');
    const LinuxEditorFsContextMod = await import('@/terminal/sessions/LinuxEditorFsContext');
    const fsCtx = new LinuxEditorFsContextMod.LinuxEditorFsContext(pc);
    const vim = new VimEngineMod.VimEngine(fsCtx, '', '', true, 'vim');
    vim.applyKey({ key: 'i', ctrl: false, shift: false, alt: false });
    for (const ch of 'hello') vim.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    vim.applyKey({ key: 'Escape', ctrl: false, shift: false, alt: false });
    for (const ch of ':w /tmp/real.txt') vim.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    vim.applyKey({ key: 'Enter', ctrl: false, shift: false, alt: false });
    expect(fsCtx.readFile('/tmp/real.txt')).toBe('hello\n');
  });

  it('aucun fichier swap bogué n\'est créé pour le buffer sans nom', async () => {
    const VimEngineMod = await import('@/network/devices/linux/editors/VimEngine');
    const LinuxEditorFsContextMod = await import('@/terminal/sessions/LinuxEditorFsContext');
    const fsCtx = new LinuxEditorFsContextMod.LinuxEditorFsContext(pc);
    const vim = new VimEngineMod.VimEngine(fsCtx, '', '', true, 'vim');
    expect(vim.swapFilePath).toBe('');
    expect(vim.swapFileExists).toBe(false);
  });
});
