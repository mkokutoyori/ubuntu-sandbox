/**
 * Nano — navigation manquante : saut par mot (Ctrl+←/→) et début/fin de
 * fichier (M-\ / M-/). Aucun des deux n'était lié : le curseur ne
 * pouvait se déplacer que flèche par flèche ou ligne par ligne, ce qui
 * rend la navigation dans un fichier long pénible.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrlArrow(engine: { applyKey(k: EditorKeyInput): void }, dir: 'ArrowLeft' | 'ArrowRight'): void {
  engine.applyKey(editorKey(dir, { ctrl: true }));
}
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

function newEngine(content: string): NanoEngine {
  const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
  return new NanoEngine(fs, '/tmp/x.txt', content, false);
}

describe('Scénario — Ctrl+→ saute au début du mot suivant', () => {
  it('depuis le début de la ligne, atterrit au début du deuxième mot', () => {
    const nano = newEngine('foo bar baz\n');
    ctrlArrow(nano, 'ArrowRight');
    expect(nano.cursorCol).toBe(4); // start of "bar"
  });

  it('depuis le milieu d\'un mot, atterrit au début du mot suivant', () => {
    const nano = newEngine('foo bar baz\n');
    for (let i = 0; i < 2; i++) press(nano, 'ArrowRight'); // cursor inside "foo"
    ctrlArrow(nano, 'ArrowRight');
    expect(nano.cursorCol).toBe(4);
  });

  it('en fin de ligne, passe à la ligne suivante', () => {
    const nano = newEngine('foo\nbar baz\n');
    press(nano, 'End');
    ctrlArrow(nano, 'ArrowRight');
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(0);
  });

  it('plusieurs espaces consécutifs sont traversés en un seul saut', () => {
    const nano = newEngine('foo    bar\n');
    ctrlArrow(nano, 'ArrowRight');
    expect(nano.cursorCol).toBe(7);
  });

  it('en fin de fichier, ne fait rien (reste sur place)', () => {
    const nano = newEngine('foo\n');
    press(nano, 'End');
    ctrlArrow(nano, 'ArrowRight');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(3);
  });
});

describe('Scénario — Ctrl+← saute au début du mot précédent', () => {
  it('depuis la fin de la ligne, atterrit au début du dernier mot', () => {
    const nano = newEngine('foo bar baz\n');
    press(nano, 'End');
    ctrlArrow(nano, 'ArrowLeft');
    expect(nano.cursorCol).toBe(8); // start of "baz"
  });

  it('depuis le milieu d\'un mot, atterrit au début de CE mot', () => {
    const nano = newEngine('foo bar baz\n');
    for (let i = 0; i < 6; i++) press(nano, 'ArrowRight'); // inside "bar"
    ctrlArrow(nano, 'ArrowLeft');
    expect(nano.cursorCol).toBe(4); // start of "bar"
  });

  it('depuis le début d\'un mot, saute au mot PRÉCÉDENT (pas sur place)', () => {
    const nano = newEngine('foo bar baz\n');
    for (let i = 0; i < 4; i++) press(nano, 'ArrowRight'); // exactly at start of "bar"
    ctrlArrow(nano, 'ArrowLeft');
    expect(nano.cursorCol).toBe(0); // start of "foo"
  });

  it('en début de ligne, remonte à la fin de la ligne précédente', () => {
    const nano = newEngine('foo bar\nbaz\n');
    press(nano, 'ArrowDown');
    ctrlArrow(nano, 'ArrowLeft');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(7);
  });

  it('en tout début de fichier, ne fait rien', () => {
    const nano = newEngine('foo\n');
    ctrlArrow(nano, 'ArrowLeft');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });
});

describe('Scénario — M-\\ (First Line) et M-/ (Last Line)', () => {
  it('M-\\ place le curseur au tout début du fichier', () => {
    const nano = newEngine('a\nb\nc\n');
    press(nano, 'ArrowDown'); press(nano, 'ArrowDown');
    alt(nano, '\\');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0);
  });

  it('M-/ place le curseur à la toute fin du fichier', () => {
    const nano = newEngine('a\nbb\nccc\n');
    alt(nano, '/');
    expect(nano.cursorLine).toBe(2);
    expect(nano.cursorCol).toBe(3);
  });

  it('un mouvement de fichier interrompt la coalescence undo', () => {
    const nano = newEngine('a\nb\n');
    press(nano, 'X');
    alt(nano, '/');
    press(nano, 'Y');
    alt(nano, 'u'); // undoes only "Y"
    expect(nano.lines.some((l) => l.includes('Y'))).toBe(false);
    expect(nano.lines.some((l) => l.includes('X'))).toBe(true);
  });
});
