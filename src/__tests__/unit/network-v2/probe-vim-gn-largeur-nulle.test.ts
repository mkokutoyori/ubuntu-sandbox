/**
 * vim (search.c, current_search / is_zero_width) : `gn` sélectionne le motif SOUS le curseur (même si le curseur est au milieu du motif),
 * sinon le suivant ; avec un motif de largeur nulle (`^`, `$`, `x*`), il sélectionne le caractère à la position de l'appariement vide
 * et ne déborde pas sur le saut de ligne précédent.
 * Mesure de départ : curseur au milieu du motif, `gn` sautait au motif suivant ; avec `^`, il sélectionnait le saut de ligne.
 * 3 des 5 cas tombent avant ; les deux témoins (curseur avant le motif, `dgn` d'un mot) passent dans les deux états.
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

function press(vim: VimEngine, keys: string): void {
  for (const ch of keys) vim.applyKey(ch === '\n' ? editorKey('Enter') : editorKey(ch));
}

describe('gn', () => {
  it('curseur avant le motif : sélectionne le motif et dgn le supprime', () => {
    const vim = edit('foo bar baz\n');
    press(vim, '/bar\n');
    press(vim, '0dgn');
    expect(vim.content).toBe('foo  baz');
  });

  it('curseur au milieu du motif : dgn supprime CE motif', () => {
    const vim = edit('foo bar baz bar\n');
    press(vim, '/bar\n');
    press(vim, '0');
    press(vim, '5l');
    press(vim, 'dgn');
    expect(vim.content).toBe('foo  baz bar');
  });

  it('motif de largeur nulle ^ : dgn supprime le caractère en colonne 0, pas le saut de ligne', () => {
    const vim = edit('abc\ndef\n');
    press(vim, '/^\n');
    press(vim, 'gg');
    press(vim, 'dgn');
    expect(vim.content).toBe('bc\ndef');
  });

  it('motif de largeur nulle $ : cgn remplace le dernier caractère de la ligne', () => {
    const vim = edit('abc\ndef\n');
    press(vim, '/$\n');
    press(vim, 'gg');
    press(vim, 'dgn');
    expect(vim.content.split('\n')[0].length).toBeLessThanOrEqual(3);
  });

  it('gN sélectionne le motif précédent', () => {
    const vim = edit('bar foo bar\n');
    press(vim, '/bar\n');
    press(vim, '$');
    press(vim, 'dgN');
    expect(vim.content).toBe('bar foo ');
  });
});
