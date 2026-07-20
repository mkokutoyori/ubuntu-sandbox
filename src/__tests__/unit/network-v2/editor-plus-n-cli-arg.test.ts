/**
 * `nano +N fichier` / `nano +N,C fichier` / `vim +N fichier` : le
 * curseur doit se positionner à la ligne (et colonne, pour nano) donnée
 * dès l'ouverture. L'argument `+N` était déjà filtré du nom de fichier
 * par openEditor (donc `nano +42 x.txt` ouvrait bien x.txt et pas un
 * fichier "+42") mais silencieusement jeté sans jamais bouger le
 * curseur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

function longFile(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

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

describe('Scénario — `nano +N fichier` positionne le curseur à la ligne N à l\'ouverture', () => {
  it('filePath/absolutePath restent le VRAI nom de fichier, pas "+42"', async () => {
    await pc.executeCommand('for i in $(seq 1 50); do echo "line $i" >> /tmp/big.txt; done');
    await type('nano +42 /tmp/big.txt');
    const mode = session.inputMode as { absolutePath: string; initialCursorLine?: number };
    expect(mode.absolutePath).toBe('/tmp/big.txt');
    expect(mode.initialCursorLine).toBe(42);
  });

  it('le moteur NanoEngine se retrouve avec le curseur à la ligne 42 (1-indexée)', async () => {
    const content = longFile(50);
    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/tmp/x.txt', content, false, false, { line: 42 });
    expect(nano.cursorLine).toBe(41); // 0-indexed internally
    expect(nano.cursorCol).toBe(0);
  });

  it('`+N,C` positionne aussi la colonne', async () => {
    const content = longFile(50);
    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/tmp/x.txt', content, false, false, { line: 10, col: 3 });
    expect(nano.cursorLine).toBe(9);
    expect(nano.cursorCol).toBe(2);
  });

  it('une ligne au-delà de la fin du fichier clampe à la dernière ligne', async () => {
    const content = longFile(10);
    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/tmp/x.txt', content, false, false, { line: 9999 });
    expect(nano.cursorLine).toBe(9);
  });

  it('sans +N, le curseur démarre en (0,0) comme avant', () => {
    const content = longFile(10);
    const fsCtx = new LinuxEditorFsContext(pc);
    const nano = new NanoEngine(fsCtx, '/tmp/x.txt', content, false, false);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });
});

describe('Scénario — `vim +N fichier` positionne le curseur à la ligne N à l\'ouverture', () => {
  it('filePath/absolutePath restent le VRAI nom de fichier', async () => {
    await pc.executeCommand('for i in $(seq 1 50); do echo "line $i" >> /tmp/big2.txt; done');
    await type('vim +15 /tmp/big2.txt');
    const mode = session.inputMode as { absolutePath: string; initialCursorLine?: number };
    expect(mode.absolutePath).toBe('/tmp/big2.txt');
    expect(mode.initialCursorLine).toBe(15);
  });

  it('le moteur VimEngine se retrouve avec le curseur à la ligne 15 (1-indexée)', async () => {
    const content = longFile(50);
    const fsCtx = new LinuxEditorFsContext(pc);
    const vim = new VimEngine(fsCtx, '/tmp/y.txt', content, false, 'vim', 'user', { line: 15 });
    expect(vim.cursorLine).toBe(14);
  });
});
