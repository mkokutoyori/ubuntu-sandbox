/**
 * Scénario 14 (auto-conçu) — Undo/redo nano (Alt+U / Alt+E, `M-U`/`M-E`
 * dans la notation nano réelle), multi-niveaux, avec regroupement des
 * actions consécutives de même nature (une frappe continue de
 * caractères s'annule en un seul geste, tout comme une série de
 * Backspace) — le comportement de regroupement documenté de nano ≥ 2.9.
 *
 * Sémantique réelle reproduite :
 *  - Taper plusieurs caractères sans bouger le curseur ni changer de
 *    type d'action = un seul groupe annulable.
 *  - Un déplacement du curseur, ou un changement de type d'action
 *    (frappe → Backspace, etc.), ferme le groupe courant : l'annulation
 *    suivante ne défera que les actions du nouveau groupe.
 *  - Entrée (nouvelle ligne) est toujours sa propre étape, jamais fondue
 *    avec le texte tapé avant ou après.
 *  - Une nouvelle modification après une annulation vide la pile de
 *    rétablissement (comportement undo/redo standard).
 *  - Revenir par annulations successives jusqu'à l'état initial du
 *    fichier efface l'indicateur "Modified".
 *
 * Portée assumée : chaque Cut Text (^K) reste sa propre étape
 * d'annulation même si plusieurs ^K se suivent (contrairement à un
 * usage courant réel où nano les regrouperait aussi) — simplification
 * assumée pour ce scénario, non testée comme un regroupement.
 *
 * TDD: written against the headless NanoEngine, before any undo/redo
 * state exists (confirmed via grep: no "undo"/"redo" in NanoEngine.ts).
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) press(engine, ch);
}
function undo(engine: { applyKey(k: EditorKeyInput): void }): void { press(engine, 'u', { alt: true }); }
function redo(engine: { applyKey(k: EditorKeyInput): void }): void { press(engine, 'e', { alt: true }); }
function make(content: string, path = '/tmp/undo.txt'): NanoEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new NanoEngine(fs, path, content, false, false);
}

describe('Scénario 14 — Alt+U annule, Alt+E rétablit, sur pile vide', () => {
  it('Alt+U sur un buffer non modifié affiche "Nothing to undo!" et ne change rien', () => {
    const nano = make('hello\n');
    undo(nano);
    expect(nano.statusMessage).toBe('Nothing to undo!');
    expect(nano.lines).toEqual(['hello']);
  });

  it('Alt+E sans annulation préalable affiche "Nothing to redo!"', () => {
    const nano = make('hello\n');
    redo(nano);
    expect(nano.statusMessage).toBe('Nothing to redo!');
  });
});

describe('Scénario 14 — une frappe continue de caractères forme un seul groupe annulable', () => {
  it('taper "abc" puis Alt+U retire les trois caractères en un seul geste', () => {
    const nano = make('\n');
    typeText(nano, 'abc');
    expect(nano.lines[0]).toBe('abc');
    undo(nano);
    expect(nano.lines[0]).toBe('');
    expect(nano.statusMessage).toBe('Undid action');
  });

  it('Alt+E après Alt+U rétablit exactement le texte tapé', () => {
    const nano = make('\n');
    typeText(nano, 'abc');
    undo(nano);
    redo(nano);
    expect(nano.lines[0]).toBe('abc');
    expect(nano.statusMessage).toBe('Redid action');
  });

  it('un déplacement du curseur ferme le groupe : deux frappes séparées par un mouvement s\'annulent séparément', () => {
    const nano = make('\n');
    typeText(nano, 'abc');
    press(nano, 'ArrowLeft'); // breaks the coalescing group
    typeText(nano, 'def');
    // buffer is now "abdefc" (def inserted after moving left once from end of "abc")
    expect(nano.lines[0]).toBe('abdefc');

    undo(nano); // undoes only "def"
    expect(nano.lines[0]).toBe('abc');
    undo(nano); // undoes "abc"
    expect(nano.lines[0]).toBe('');
  });
});

describe('Scénario 14 — Backspace se regroupe aussi, mais pas avec une frappe de type différent', () => {
  it('plusieurs Backspace consécutifs ne forment qu\'un seul groupe annulable', () => {
    const nano = make('abcdef\n');
    press(nano, 'End');
    press(nano, 'Backspace');
    press(nano, 'Backspace');
    press(nano, 'Backspace');
    expect(nano.lines[0]).toBe('abc');
    undo(nano);
    expect(nano.lines[0]).toBe('abcdef');
  });

  it('passer de la frappe au Backspace ferme le groupe de frappe en cours', () => {
    const nano = make('\n');
    typeText(nano, 'abc');
    press(nano, 'Backspace'); // new group: backspace
    expect(nano.lines[0]).toBe('ab');
    undo(nano); // undoes only the backspace
    expect(nano.lines[0]).toBe('abc');
    undo(nano); // undoes the "abc" typing group
    expect(nano.lines[0]).toBe('');
  });
});

describe('Scénario 14 — Entrée est toujours une étape distincte', () => {
  it("Entrée ne se fond jamais avec le texte tapé avant ou après, même sans mouvement du curseur", () => {
    const nano = make('\n');
    typeText(nano, 'first');
    press(nano, 'Enter');
    typeText(nano, 'second');
    expect(nano.lines).toEqual(['first', 'second']);

    undo(nano); // undoes "second" only
    expect(nano.lines).toEqual(['first', '']);
    undo(nano); // undoes the Enter (merges the lines back)
    expect(nano.lines).toEqual(['first']);
    undo(nano); // undoes "first"
    expect(nano.lines).toEqual(['']);
  });
});

describe('Scénario 14 — une nouvelle modification après une annulation vide le rétablissement', () => {
  it('taper autre chose après Alt+U empêche tout Alt+E ultérieur de rétablir l\'ancien texte', () => {
    const nano = make('\n');
    typeText(nano, 'abc');
    undo(nano);
    typeText(nano, 'xyz');
    expect(nano.lines[0]).toBe('xyz');
    redo(nano);
    expect(nano.statusMessage).toBe('Nothing to redo!');
    expect(nano.lines[0]).toBe('xyz'); // unchanged -- "abc" was never coming back
  });
});

describe("Scénario 14 — l'indicateur Modified s'efface en revenant à l'état initial", () => {
  it('annuler jusqu\'à l\'état de chargement initial repasse modified à false', () => {
    const nano = make('original\n');
    typeText(nano, 'X');
    expect(nano.modified).toBe(true);
    undo(nano);
    expect(nano.lines[0]).toBe('original');
    expect(nano.modified).toBe(false);
  });
});

describe('Scénario 14 — undo/redo multi-niveaux (plusieurs groupes empilés)', () => {
  it('trois groupes successifs s\'annulent puis se rétablissent un par un, dans le bon ordre', () => {
    const nano = make('\n');
    typeText(nano, 'one');
    const afterOne = nano.lines[0];
    press(nano, 'ArrowLeft');
    typeText(nano, 'two');
    const afterTwo = nano.lines[0];
    press(nano, 'ArrowLeft');
    typeText(nano, 'three');
    const fullyTyped = nano.lines[0];

    undo(nano);
    expect(nano.lines[0]).toBe(afterTwo);
    undo(nano);
    expect(nano.lines[0]).toBe(afterOne);
    undo(nano);
    expect(nano.lines[0]).toBe('');

    redo(nano);
    expect(nano.lines[0]).toBe(afterOne);
    redo(nano);
    expect(nano.lines[0]).toBe(afterTwo);
    redo(nano);
    expect(nano.lines[0]).toBe(fullyTyped);
  });
});
