/**
 * vim (mbyte.c, utfc_ptr2len / mb_ptr_back) : un caractère est un point de code PLUS les caractères combinants qui le suivent ; `l`, `h`,
 * `x`, la touche d'effacement et les flèches avancent d'un caractère entier, jamais d'une moitié de paire de substitution.
 * Mesure de départ : un emoji (U+1F600) valait deux colonnes pour `l`, `x`, `h`, et e + U+0301 deux caractères.
 * 5 des 6 cas tombent avant ; le témoin (texte ASCII) passe dans les deux états.
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

const press = (vim: VimEngine, keys: string): void => { for (const ch of keys) vim.applyKey(editorKey(ch)); };

describe('caractères hors du plan de base et combinants', () => {
  it('l saute un emoji entier', () => {
    const vim = edit('a\u{1F600}b\n');
    press(vim, 'll');
    expect(vim.cursorCol).toBe(3);
  });

  it('h revient sur l\'emoji entier', () => {
    const vim = edit('a\u{1F600}b\n');
    press(vim, 'llh');
    expect(vim.cursorCol).toBe(1);
  });

  it('x supprime l\'emoji entier', () => {
    const vim = edit('a\u{1F600}b\n');
    press(vim, 'lx');
    expect(vim.content).toBe('ab');
  });

  it('x supprime e + accent combinant d\'un bloc', () => {
    const vim = edit('xéy\n');
    press(vim, 'lx');
    expect(vim.content).toBe('xy');
  });

  it('retour arrière en insertion supprime l\'emoji entier', () => {
    const vim = edit('a\u{1F600}\n');
    press(vim, 'A');
    vim.applyKey(editorKey('Backspace'));
    expect(vim.content).toBe('a');
  });

  it('témoin : ASCII', () => {
    const vim = edit('abc\n');
    press(vim, 'lx');
    expect(vim.content).toBe('ac');
  });
});
