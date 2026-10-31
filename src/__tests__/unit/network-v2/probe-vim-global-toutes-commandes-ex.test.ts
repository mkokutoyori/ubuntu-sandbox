/**
 * vim (ex_cmds.c, global_exe / ml_setmarked) : `:g/pat/cmd` exécute N'IMPORTE QUELLE commande ex sur chaque ligne marquée, les marques
 * suivant les lignes quand une commande en insère ou en retire ; `:normal` joue des touches du mode normal.
 * Mesure de départ : seuls `d` et `s///` s'exécutaient, tout le reste (`m0`, `t.`, `j`, `normal dd`, `>`) était ignoré sans message.
 * 6 des 7 cas tombent avant ; le témoin (`:g/x/d`) passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function edit(text: string): VimEngine {
  const fs = new InMemoryEditorFsContext();
  fs.writeFile('/tmp/f', text);
  return new VimEngine(fs, '/tmp/f', text, false, 'vim', 'root');
}

function ex(vim: VimEngine, command: string): void {
  vim.applyKey(editorKey(':'));
  for (const ch of command) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
}

describe(':g avec toutes les commandes ex', () => {
  it(':g/^/m0 renverse le fichier', () => {
    const vim = edit('a\nb\nc\nd\n');
    ex(vim, 'g/^/m0');
    expect(vim.content).toBe('d\nc\nb\na');
  });

  it(':g/x/t. duplique chaque ligne qui contient x', () => {
    const vim = edit('ax\nb\ncx\n');
    ex(vim, 'g/x/t.');
    expect(vim.content).toBe('ax\nax\nb\ncx\ncx');
  });

  it(':g/x/normal dd supprime les lignes', () => {
    const vim = edit('ax\nb\ncx\nd\n');
    ex(vim, 'g/x/normal dd');
    expect(vim.content).toBe('b\nd');
  });

  it(':g/a/j joint chaque ligne a avec la suivante', () => {
    const vim = edit('a\nb\na\nc\n');
    ex(vim, 'g/a/j');
    expect(vim.content).toBe('a b\na c');
  });

  it(':g/x/> indente', () => {
    const vim = edit('x\ny\nx\n');
    ex(vim, 'g/x/>');
    expect(vim.content.split('\n')[0]).toMatch(/^\s+x$/);
    expect(vim.content.split('\n')[1]).toBe('y');
  });

  it(':normal avec une plage joue les touches sur chaque ligne', () => {
    const vim = edit('a\nb\nc\n');
    ex(vim, '1,2normal Ax');
    expect(vim.content).toBe('ax\nbx\nc');
  });

  it('témoin : :g/x/d supprime', () => {
    const vim = edit('ax\nb\ncx\n');
    ex(vim, 'g/x/d');
    expect(vim.content).toBe('b');
  });
});
