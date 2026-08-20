/**
 * Nano — sélection de région : ^6/M-A pose une marque, M-6 copie la
 * région marquée (ou la ligne courante sans marque), et ^K coupe la
 * région marquée au lieu de la ligne entière quand une marque est
 * active. Aucun des trois n'existait : impossible de copier/couper
 * autre chose qu'une ligne entière à la fois.
 *
 * Corrige aussi un bug de ^U (Paste) : le curseur restait à l'ancienne
 * position au lieu de se retrouver après le texte collé.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

function newEngine(content: string, readOnly = false): NanoEngine {
  const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
  return new NanoEngine(fs, '/tmp/x.txt', content, false, readOnly);
}

describe('Scénario — ^K sans marque : comportement existant préservé (ligne entière)', () => {
  it('^K coupe la ligne courante entière, comme avant', () => {
    const nano = newEngine('a\nb\nc\n');
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['b', 'c']);
  });

  it('deux ^K consécutifs accumulent, comme avant', () => {
    const nano = newEngine('a\nb\nc\n');
    ctrl(nano, 'k');
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['c']);
    ctrl(nano, 'u');
    expect(nano.lines).toEqual(['a', 'b', 'c']);
  });
});

describe('Scénario — ^6 / M-A pose et enlève une marque', () => {
  it('^6 pose une marque à la position du curseur', () => {
    const nano = newEngine('hello world\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight');
    ctrl(nano, '6');
    expect(nano.statusMessage).toBe('Mark Set');
  });

  it('M-A pose la même marque (alias documenté de real nano)', () => {
    const nano = newEngine('hello world\n');
    alt(nano, 'a');
    expect(nano.statusMessage).toBe('Mark Set');
  });

  it('poser puis reposer une marque l\'enlève', () => {
    const nano = newEngine('hello\n');
    ctrl(nano, '6');
    ctrl(nano, '6');
    expect(nano.statusMessage).toBe('Mark Unset');
  });
});

describe('Scénario — M-6 copie la région marquée (ou la ligne courante sans marque)', () => {
  it('sans marque, copie la ligne courante — le buffer original n\'est pas modifié', () => {
    const nano = newEngine('hello world\n');
    alt(nano, '6');
    expect(nano.lines).toEqual(['hello world']);
    expect(nano.modified).toBe(false);
    ctrl(nano, 'u');
    expect(nano.lines).toEqual(['hello world', 'hello world']);
  });

  it('avec une marque mi-ligne, copie exactement le texte encadré (pas la ligne entière)', () => {
    const nano = newEngine('hello world\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight'); // just before "world"
    ctrl(nano, '6');
    press(nano, 'End'); // extend to end of line
    alt(nano, '6');
    // Move elsewhere and paste to verify the exact copied text.
    press(nano, 'Home');
    ctrl(nano, 'u');
    expect(nano.lines).toEqual(['worldhello world']);
  });

  it('une marque sur plusieurs lignes copie le texte à travers les sauts de ligne', () => {
    const nano = newEngine('foo\nbar\nbaz\n');
    press(nano, 'ArrowRight'); press(nano, 'ArrowRight'); // (0,2), inside "foo"
    ctrl(nano, '6');
    press(nano, 'ArrowDown'); press(nano, 'ArrowDown'); // (2,2), inside "baz"
    alt(nano, '6');
    // Copying does not delete anything.
    expect(nano.lines).toEqual(['foo', 'bar', 'baz']);
    // Paste it back at the very start to inspect the exact captured text.
    press(nano, 'ArrowUp'); press(nano, 'ArrowUp'); press(nano, 'Home');
    ctrl(nano, 'u');
    expect(nano.lines).toEqual(['o', 'bar', 'bafoo', 'bar', 'baz']);
  });

  it('après une copie de région, la marque est levée', () => {
    const nano = newEngine('hello\n');
    ctrl(nano, '6');
    alt(nano, '6');
    ctrl(nano, '6'); // if the mark had survived, this would UNSET it and print "Mark Unset"
    expect(nano.statusMessage).toBe('Mark Set');
  });
});

describe('Scénario — ^K avec une marque active coupe la région, pas la ligne', () => {
  it('une marque mi-ligne : ^K supprime exactement le texte encadré', () => {
    const nano = newEngine('hello world\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight');
    ctrl(nano, '6');
    press(nano, 'End');
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['hello ']);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(6);
  });

  it('une marque multi-lignes : ^K fusionne les fragments de bord en une seule ligne', () => {
    const nano = newEngine('foo\nbar\nbaz\n');
    press(nano, 'ArrowRight'); press(nano, 'ArrowRight'); // (0,2)
    ctrl(nano, '6');
    press(nano, 'ArrowDown'); press(nano, 'ArrowDown'); // (2,2)
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['foz']); // "fo" + "z" (tail of "baz" after col2)
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(2);
  });

  it('la marque est levée après la coupe', () => {
    const nano = newEngine('hello\n');
    ctrl(nano, '6');
    press(nano, 'End');
    ctrl(nano, 'k');
    // A second ^K right after must cut the (now different) current LINE,
    // not extend/reuse a stale region.
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['']);
  });

  it('couper une région marquée est un pas d\'annulation unique et discret (pas fondu avec un ^K de ligne voisin)', () => {
    const nano = newEngine('hello world\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight');
    ctrl(nano, '6');
    press(nano, 'End');
    ctrl(nano, 'k');
    alt(nano, 'u');
    expect(nano.lines).toEqual(['hello world']);
  });

  it('mode vue (-v) : ^K reste bloqué même avec une marque active', () => {
    const nano = newEngine('hello world\n', true);
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight');
    ctrl(nano, '6');
    press(nano, 'End');
    ctrl(nano, 'k');
    expect(nano.lines).toEqual(['hello world']);
  });
});

describe('Scénario — ^U (Paste) place désormais le curseur APRÈS le texte collé', () => {
  it('coller des lignes entières avance le curseur d\'autant de lignes', () => {
    const nano = newEngine('a\nb\nX\n');
    press(nano, 'ArrowDown'); // on "b"
    ctrl(nano, 'k'); // cuts "b"
    expect(nano.lines).toEqual(['a', 'X']);
    press(nano, 'ArrowDown'); // on "X"
    ctrl(nano, 'u'); // paste "b" back before "X"
    expect(nano.lines).toEqual(['a', 'b', 'X']);
    expect(nano.cursorLine).toBe(2); // right after the pasted line, on "X"
    expect(nano.cursorCol).toBe(0);
  });

  it('coller une région place le curseur juste après le texte collé', () => {
    const nano = newEngine('hello world\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight');
    ctrl(nano, '6');
    press(nano, 'End');
    alt(nano, '6'); // copy "world"
    press(nano, 'Home');
    ctrl(nano, 'u'); // paste "world" at the very start
    expect(nano.lines).toEqual(['worldhello world']);
    expect(nano.cursorCol).toBe(5); // right after "world", before "hello"
  });
});
