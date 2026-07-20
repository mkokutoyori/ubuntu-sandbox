/**
 * Nano — numéros de ligne : `nano -l` / `--linenumbers` les affiche dès
 * l'ouverture, M-# les bascule à la volée. Aucun des deux n'existait —
 * pas d'équivalent à la gouttière déjà présente dans VimEditor.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

function newEngine(content = 'a\nb\nc\n'): NanoEngine {
  const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': content });
  return new NanoEngine(fs, '/tmp/x.txt', content, false);
}

describe('Scénario — off par défaut, comme le vrai nano', () => {
  it('lineNumbersShown est false par défaut', () => {
    const nano = newEngine();
    expect(nano.lineNumbersShown).toBe(false);
  });
});

describe('Scénario — `nano -l` (constructeur) affiche les numéros dès l\'ouverture', () => {
  it('le drapeau linenumbers active lineNumbersShown', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\nb\n', false, false, undefined, true);
    expect(nano.lineNumbersShown).toBe(true);
  });
});

describe('Scénario — M-# bascule les numéros de ligne à la volée', () => {
  it('un premier M-# les active', () => {
    const nano = newEngine();
    alt(nano, '#');
    expect(nano.lineNumbersShown).toBe(true);
  });

  it('un second M-# les désactive', () => {
    const nano = newEngine();
    alt(nano, '#');
    alt(nano, '#');
    expect(nano.lineNumbersShown).toBe(false);
  });

  it('fonctionne aussi en mode vue (-v) : c\'est un réglage d\'affichage, pas une mutation du buffer', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false, true);
    alt(nano, '#');
    expect(nano.lineNumbersShown).toBe(true);
  });

  it('basculer les numéros ne modifie ni le buffer ni "modified"', () => {
    const nano = newEngine();
    alt(nano, '#');
    expect(nano.lines).toEqual(['a', 'b', 'c']);
    expect(nano.modified).toBe(false);
  });

  it('basculer les numéros n\'interrompt pas la coalescence undo (ce n\'est pas une frappe de contenu)', () => {
    const nano = newEngine('\n');
    press(nano, 'X');
    alt(nano, '#');
    press(nano, 'Y');
    expect(nano.lines).toEqual(['XY']);
  });
});
