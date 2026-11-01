/**
 * vim 9.1.0016 sous tmux (collage encadre, « paste-buffer -p ») : en mode Normal le texte est inséré AVANT le curseur comme par « P » (le curseur finit sur le dernier caractère collé), en mode Insertion il est inséré tel quel, sans indentation automatique ; le fichier relevé après « :w » vaut « ALPHA / ___BETA / GAMMAL1 / __inALPHA / ___BETA / GAMMAdented / L3 ».
 * Mesure de départ : VimEngine n'avait pas d'applyPaste et VimEditor ni gestionnaire de collage ni geste Ctrl+Maj+V / Maj+Inser / clic droit. Les 4 cas tombent avant.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const TEXT = 'ALPHA\n   BETA\nGAMMA';

function open(): VimEngine {
  const fs = new InMemoryEditorFsContext({ '/tmp/f.txt': 'L1\n  indented\nL3\n' });
  return new VimEngine(fs, '/tmp/f.txt', 'L1\n  indented\nL3\n', false, 'vim', 'root');
}

describe('coller dans vim', () => {
  it('en Normal, avant le curseur, comme P', () => {
    const vim = open();
    vim.applyPaste(TEXT);
    expect(vim.content).toBe('ALPHA\n   BETA\nGAMMAL1\n  indented\nL3');
    expect(vim.cursorLine).toBe(2);
    expect(vim.cursorCol).toBe(4);
  });

  it('en Insertion, tel quel, sans indentation automatique, et le fichier relevé s\'obtient', () => {
    const vim = open();
    vim.applyPaste(TEXT);
    vim.applyKey(editorKey('j'));
    vim.applyKey(editorKey('i'));
    vim.applyPaste(TEXT);
    vim.applyKey(editorKey('Escape'));
    expect(vim.content).toBe('ALPHA\n   BETA\nGAMMAL1\n  inALPHA\n   BETA\nGAMMAdented\nL3');
  });

  it('un collage retourne à la ligne comme un seul geste d\'annulation', () => {
    const vim = open();
    vim.applyPaste(TEXT);
    vim.applyKey(editorKey('u'));
    expect(vim.content).toBe('L1\n  indented\nL3');
  });

  it('sur la ligne de commande, la première ligne seulement', () => {
    const vim = open();
    vim.applyKey(editorKey(':'));
    vim.applyPaste('set nu\nsecond');
    expect(vim.commandLineText).toContain('set nu');
    expect(vim.commandLineText).not.toContain('second');
  });
});
