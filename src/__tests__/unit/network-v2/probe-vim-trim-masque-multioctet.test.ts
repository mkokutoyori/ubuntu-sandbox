/**
 * vim (evalfunc.c f_trim) : trim() avec un masque multioctet, résultats relevés sur vim 8.2 réel.
 * Mesure de départ : l'entrée TODO annonçait l'absence ; les 4 cas passent déjà avant le correctif (non-régression), l'entrée était périmée.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string): string {
  const fs = new InMemoryEditorFsContext();
  fs.writeFile('/tmp/f', 'x\n');
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s/x/\\=${expression}/`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content;
}

describe('trim multioctet', () => {
  it('deux côtés', () => { expect(evaluate('trim("éaébé", "é")')).toBe('aéb'); });
  it('début', () => { expect(evaluate('trim("éaébé", "é", 1)')).toBe('aébé'); });
  it('fin', () => { expect(evaluate('trim("éaébé", "é", 2)')).toBe('éaéb'); });
  it('masque de deux caractères', () => { expect(evaluate('trim("éxaé", "éx")')).toBe('a'); });
});
