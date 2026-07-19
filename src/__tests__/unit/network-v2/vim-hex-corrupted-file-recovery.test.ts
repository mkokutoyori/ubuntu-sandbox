/**
 * Scénario 10 — Récupération de fichiers corrompus via l'édition
 * hexadécimale de vim : nettoyage CRLF/CR isolé (`\r`), suppression d'un
 * octet NUL embarqué via `:%!xxd` / `:%!xxd -r`, et nettoyage d'un BOM
 * égaré via `\%ufeff`. Détection/écriture du `fileformat` (unix/dos).
 *
 * TDD: written against the real device (LinuxPC) + the production
 * LinuxEditorFsContext adapter, driving VimEngine exactly as the real UI
 * would, then validating through genuine `pc.executeCommand` calls
 * (including the real `xxd` command, byte for byte).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function exCommand(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}

let pc: LinuxPC;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
});

describe('Scénario 10 — nettoyage CRLF / CR isolé via \\r et :set fileformat?', () => {
  it('détecte fileformat=dos, localise le CR isolé par recherche, et le supprime par substitution', async () => {
    // Simule un fichier converti en DOS mais corrompu par un ancien CR Mac
    // (\r seul, sans \n) fusionné au milieu d'une ligne lors d'une
    // concaténation ratée — le \r\n propre est déjà normalisé au chargement
    // (comme le ferait vim), seul le CR isolé reste visible dans le buffer.
    const content = 'line1\r\nline2\rline2b\r\nline3\n';
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/crlf-corrupt.txt', content);

    const vim = new VimEngine(fsCtx, '/tmp/crlf-corrupt.txt', fsCtx.readFile('/tmp/crlf-corrupt.txt')!, false, 'vim');
    exCommand(vim, 'set fileformat?');
    expect(vim.message).toBe('fileformat=dos');
    expect(vim.lines).toEqual(['line1', 'line2\rline2b', 'line3']);

    press(vim, '/');
    typeText(vim, '\\r');
    press(vim, 'Enter');
    expect(vim.cursorLine).toBe(1);
    expect(vim.lines[vim.cursorLine]).toContain('\r');

    exCommand(vim, '%s/\\r//g');
    expect(vim.lines).toEqual(['line1', 'line2line2b', 'line3']);
    expect(vim.content).not.toContain('\r');

    exCommand(vim, 'wq');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(true);

    // Real byte-level check: consistent \r\n throughout, no stray 0d left.
    // `cat`'s terminal output strips exactly one trailing newline, leaving
    // the file's final \r visible — the file on disk itself keeps \r\n.
    const written = await pc.executeCommand('cat /tmp/crlf-corrupt.txt');
    expect(written).toBe('line1\r\nline2line2b\r\nline3\r');

    const xxdOut = await pc.executeCommand('xxd /tmp/crlf-corrupt.txt');
    // Every 0d (CR) byte in the dump is immediately followed by 0a (LF) —
    // no stray, unpaired CR survived the cleanup.
    const hexDigits = xxdOut.replace(/^[0-9a-f]+:\s*/gm, '').replace(/ {2,}.*$/gm, '').replace(/\s+/g, '');
    const byteHexes: string[] = [];
    for (let i = 0; i + 1 < hexDigits.length; i += 2) byteHexes.push(hexDigits.slice(i, i + 2));
    const crAt = byteHexes.reduce<number[]>((acc, b, i) => (b === '0d' ? [...acc, i] : acc), []);
    expect(crAt.length).toBeGreaterThan(0);
    for (const i of crAt) {
      expect(byteHexes[i + 1]).toBe('0a');
    }
  });

  it('un fichier purement unix (sans \\r\\n) est détecté fileformat=unix', () => {
    const content = 'plain\nunix\nfile\n';
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/unix.txt', content);
    const vim = new VimEngine(fsCtx, '/tmp/unix.txt', fsCtx.readFile('/tmp/unix.txt')!, false, 'vim');
    exCommand(vim, 'set fileformat?');
    expect(vim.message).toBe('fileformat=unix');
  });

  it(':set fileformat=unix force une écriture LF-only au prochain :w, sans toucher le buffer', () => {
    const content = 'a\r\nb\r\n';
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/force-unix.txt', content);
    const vim = new VimEngine(fsCtx, '/tmp/force-unix.txt', fsCtx.readFile('/tmp/force-unix.txt')!, false, 'vim');
    expect(vim.fileFormat).toBe('dos');

    exCommand(vim, 'set fileformat=unix');
    expect(vim.fileFormat).toBe('unix');
    expect(vim.lines).toEqual(['a', 'b']); // buffer itself untouched by the option change

    exCommand(vim, 'wq');
    expect(fsCtx.readFile('/tmp/force-unix.txt')).toBe('a\nb\n');
  });
});

describe('Scénario 10 — octet NUL embarqué : nettoyage via :%!xxd puis :%!xxd -r', () => {
  it('localise et supprime un octet NUL en éditant le dump hexadécimal, puis restaure le binaire', async () => {
    // "ID:001" + NUL + "ID:002" + \n — a NUL embedded where a record
    // separator got corrupted into a raw zero byte.
    const content = 'ID:001\0ID:002\n';
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/nul-corrupt.bin', content);

    const vim = new VimEngine(fsCtx, '/tmp/nul-corrupt.bin', fsCtx.readFile('/tmp/nul-corrupt.bin')!, false, 'vim');

    // Real vim gates any file containing a raw NUL byte behind a binary
    // warning before rendering it as text — acknowledge it first.
    expect(vim.mode).toBe('binary-warning');
    press(vim, 'y');
    expect(vim.mode).toBe('normal');

    exCommand(vim, '%!xxd');
    expect(vim.lines.length).toBe(1);
    expect(vim.lines[0]).toContain('0049'); // the NUL (00) + 'I' (49) byte pair, grouped together
    expect(vim.lines[0]).toContain('.ID:002'); // ASCII column shows the NUL as a dot

    // Locate that exact byte pair and delete only the "00" — real
    // hex-editing: two characters removed, not a line-level operation.
    press(vim, '/');
    typeText(vim, '0049');
    press(vim, 'Enter');
    press(vim, 'x');
    press(vim, 'x');
    expect(vim.lines[0]).not.toContain('0049');
    expect(vim.lines[0]).toContain('49'); // the 'I' byte survives, now unpaired

    exCommand(vim, '%!xxd -r');
    expect(vim.content).toBe('ID:001ID:002'); // NUL gone, everything else intact, byte-exact

    exCommand(vim, 'wq');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(true);

    const written = await pc.executeCommand('cat /tmp/nul-corrupt.bin');
    expect(written).toBe('ID:001ID:002');
    const xxdAfter = await pc.executeCommand('xxd /tmp/nul-corrupt.bin');
    expect(xxdAfter).not.toContain('00'.padEnd(4)); // no NUL byte anywhere in the saved file
  });

  it(':%!xxd / :%!xxd -r round-trips ordinary text losslessly (no corruption introduced)', async () => {
    const content = 'Hello, World!\n';
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/roundtrip.txt', content);
    const vim = new VimEngine(fsCtx, '/tmp/roundtrip.txt', fsCtx.readFile('/tmp/roundtrip.txt')!, false, 'vim');

    exCommand(vim, '%!xxd');
    exCommand(vim, '%!xxd -r');
    expect(vim.content).toBe('Hello, World!');

    exCommand(vim, 'wq');
    expect(await pc.executeCommand('cat /tmp/roundtrip.txt')).toBe('Hello, World!');
  });
});

describe('Scénario 10 — BOM égaré au milieu du fichier : nettoyage via \\%ufeff', () => {
  it('supprime un BOM UTF-8 embarqué (concaténation ratée), invisible à l\'œil mais détecté par la substitution', async () => {
    const bom = '﻿';
    const content = `first line\nsecond${bom}third\nfourth\n`;
    const fsCtx = new LinuxEditorFsContext(pc);
    fsCtx.writeFile('/tmp/bom-corrupt.txt', content);
    expect(fsCtx.readFile('/tmp/bom-corrupt.txt')).toContain(bom);

    const vim = new VimEngine(fsCtx, '/tmp/bom-corrupt.txt', fsCtx.readFile('/tmp/bom-corrupt.txt')!, false, 'vim');
    expect(vim.content).toContain(bom);

    exCommand(vim, '%s/\\%ufeff//g');
    expect(vim.content).not.toContain(bom);
    expect(vim.lines).toEqual(['first line', 'secondthird', 'fourth']);

    exCommand(vim, 'wq');
    const written = await pc.executeCommand('cat /tmp/bom-corrupt.txt');
    expect(written).not.toContain(bom);
    expect(written).toBe('first line\nsecondthird\nfourth');
  });
});
