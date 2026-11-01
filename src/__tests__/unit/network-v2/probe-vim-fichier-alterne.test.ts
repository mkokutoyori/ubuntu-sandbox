/**
 * vim 9.1 : le fichier alterne (`expand('#')`, `bufname('#')`, `#:t`). Rejoue sur vim -es : vide au depart ; `:w nom` puis `:r nom` puis `:w! nom` le fixent au nom
 * passe en argument (si ce n'est pas le fichier courant) ; `bufname('#')` rend le meme nom. Le moteur n'a qu'un tampon : `:e`/`:file` n'existent pas.
 * Mesure de depart : `expand('#')` rendait toujours '' et bufname('#') aussi ; 3 des 5 cas tombent avant ; le depart vide et l'ecriture dans le fichier courant sont des temoins. `:w! nom` et `:write nom` n'etaient pas reconnus non plus.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function engine(): VimEngine {
  return new VimEngine(new InMemoryEditorFsContext({ '/tmp/b.txt': 'a\n', '/tmp/o.txt': 'z\n' }), '/tmp/b.txt', 'a\n', false, 'vim', 'root');
}

function command(vim: VimEngine, text: string): string {
  vim.applyKey(editorKey(':'));
  for (const character of text) vim.applyKey(editorKey(character));
  vim.applyKey(editorKey('Enter'));
  return vim.message;
}

describe('fichier alterne', () => {
  it('vide au depart (temoin)', () => {
    expect(command(engine(), "echo string(expand('#'))")).toBe("''");
  });

  it(':w nom le fixe', () => {
    const vim = engine();
    command(vim, 'w /tmp/saved.txt');
    expect(command(vim, "echo expand('#')")).toBe('/tmp/saved.txt');
  });

  it(':r nom le fixe', () => {
    const vim = engine();
    command(vim, 'r /tmp/o.txt');
    expect(command(vim, "echo expand('#')")).toBe('/tmp/o.txt');
  });

  it("bufname('#') et les modificateurs", () => {
    const vim = engine();
    command(vim, 'w! /tmp/second.txt');
    expect(command(vim, "echo bufname('#') expand('#:t')")).toBe('/tmp/second.txt second.txt');
  });

  it('ecrire dans le fichier courant ne le change pas', () => {
    const vim = engine();
    command(vim, 'w');
    expect(command(vim, "echo string(expand('#'))")).toBe("''");
  });
});
