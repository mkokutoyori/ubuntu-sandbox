/**
 * 'smartcase' et 'iskeyword' : ce que les corpus enregistres (vim-cursor-oracle, vim-wordclass-oracle) ne disent pas
 * en une phrase.
 *
 * Mesure de depart : `:set smartcase` et `:set iskeyword=...` repondaient `E518: Unknown option`, `/Foo` sous
 * 'ignorecase' trouvait `foo`, une etoile sur `日本語こんにちは` prenait les deux ecritures pour un seul mot, et
 * `<C-w>` ne separait pas les mots par classe.  7 des 12 cas tombent avant (git stash push -- src/network).  Cinq passent
 * des deux cotes : les deux TEMOINS (`/foo` sous 'ignorecase' seul trouve `Foo`, `w` sur `foo-bar` s'arrete au `-` avec
 * l'iskeyword de depart) et trois cas que l'ancien moteur reussit sans connaitre 'smartcase' : `:set ic scs` applique
 * 'ic' avant de refuser 'scs', donc `/foo` trouve `Foo`, `\c` l'emporte, et l'etoile ignore la casse.
 *
 * Regles lues dans vim 9.1.0016 (pat_has_uppercase, utf_class_buf, find_ident_at_pos) puis rejouees contre le binaire :
 * 'smartcase' ne s'applique ni a `*` `#` `g*` `g#`, ni a un `n` qui suit, mais s'applique a `/` `?` `:s` `:g` ; un
 * `\S` ou `\_X` n'est pas une majuscule ; `\c` et `\C` l'emportent ; une lettre majuscule non ASCII compte.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { patternHasUppercase } from '@/network/devices/linux/editors/vim/VimRegex';

function vim(content: string, variant: 'vim' | 'vi' = 'vim'): VimEngine {
  return new VimEngine(new InMemoryEditorFsContext({ '/tmp/t.txt': content }), '/tmp/t.txt', content, false, variant);
}

function type(e: VimEngine, text: string): void {
  for (const character of text) e.applyKey(character === '\r' ? editorKey('Enter') : editorKey(character));
}

function ex(e: VimEngine, command: string): string {
  e.applyKey(editorKey(':'));
  type(e, `${command}\r`);
  return e.message;
}

describe('smartcase', () => {
  it('TEMOIN : sous ignorecase seul, /foo trouve Foo', () => {
    const e = vim('x\nFoo\n');
    ex(e, 'set ic');
    type(e, '/foo\r');
    expect(e.cursorLine).toBe(1);
  });

  it('sous ignorecase et smartcase, /foo trouve encore Foo', () => {
    const e = vim('x\nFoo\n');
    ex(e, 'set ic scs');
    type(e, '/foo\r');
    expect(e.cursorLine).toBe(1);
  });

  it('sous ignorecase et smartcase, /Foo ne trouve pas foo', () => {
    const e = vim('x\nfoo\n');
    ex(e, 'set ic scs');
    type(e, '/Foo\r');
    expect(e.cursorLine).toBe(0);
    expect(e.message).toMatch(/^E486/);
  });

  it('l\'etoile ignore smartcase, et le n qui suit aussi', () => {
    const e = vim('Foo\nfoo\nFOO\n');
    ex(e, 'set ic scs');
    type(e, '*');
    expect(e.cursorLine).toBe(1);
    type(e, 'n');
    expect(e.cursorLine).toBe(2);
  });

  it(':s suit smartcase', () => {
    const e = vim('foo Foo\n');
    ex(e, 'set ic scs');
    ex(e, 's/Foo/X/');
    expect(e.lines).toEqual(['foo X']);
  });

  it('\\c l\'emporte sur smartcase', () => {
    const e = vim('foo\n');
    ex(e, 'set ic scs');
    ex(e, 's/\\cFoo/X/');
    expect(e.lines).toEqual(['X']);
  });

  it('pat_has_uppercase saute \\S, \\_X et \\%X', () => {
    expect(patternHasUppercase('\\Sfoo')).toBe(false);
    expect(patternHasUppercase('\\_Sfoo')).toBe(false);
    expect(patternHasUppercase('\\%Vfoo')).toBe(false);
    expect(patternHasUppercase('fo\\Vo')).toBe(false);
    expect(patternHasUppercase('foO')).toBe(true);
    expect(patternHasUppercase('École')).toBe(true);
    expect(patternHasUppercase('école')).toBe(false);
  });
});

describe('iskeyword', () => {
  it('TEMOIN : w sur foo-bar s\'arrete au tiret avec l\'iskeyword de depart', () => {
    const e = vim('foo-bar\n');
    type(e, 'w');
    expect(e.cursorCol).toBe(3);
  });

  it('isk+=- fait de foo-bar un seul mot', () => {
    const e = vim('foo-bar baz\n');
    ex(e, 'set isk+=-');
    type(e, 'w');
    expect(e.cursorCol).toBe(8);
  });

  it('une valeur invalide est refusee comme par vim', () => {
    const e = vim('x\n');
    expect(ex(e, 'set isk=300')).toBe('E474: Invalid argument: isk=300');
    expect(ex(e, 'set isk?')).toBe('  iskeyword=@,48-57,_,192-255');
  });

  it('une etoile ne confond pas deux ecritures', () => {
    const e = vim('日本語こんにちは\n日本語\n');
    type(e, '*');
    expect(e.cursorLine).toBe(1);
  });

  it('en profil vi, × (192-255 hors @) n\'est pas un caractere de mot, en profil vim si', () => {
    const compatible = vim('×-a\n', 'vi');
    type(compatible, 'w');
    expect(compatible.cursorCol).toBe(2);
    const standard = vim('×-a\n');
    type(standard, 'w');
    expect(standard.cursorCol).toBe(1);
  });
});
