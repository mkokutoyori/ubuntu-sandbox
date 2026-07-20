/**
 * Nano — surligner l'occurrence concernée pendant "Replace this
 * instance?". Le moteur expose déjà `pendingReplaceMatch` (ligne,
 * colonnes de début/fin en coordonnées RAW du buffer) mais rien ne
 * l'exploitait à l'affichage : l'utilisateur devait deviner quelle
 * occurrence était en train d'être proposée. `displayColumnFor` traduit
 * une colonne RAW vers sa position dans `displayContent` (qui diffère
 * dès qu'un caractère de contrôle `^X` la précède sur la même ligne),
 * exactement le calcul dont le composant a besoin pour positionner un
 * overlay `ch`-based par-dessus le textarea.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

describe('Scénario — displayColumnFor traduit une colonne RAW vers sa colonne affichée', () => {
  it('sans caractère de contrôle, la colonne affichée est identique à la colonne réelle', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'eth0 up\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'eth0 up\n', false);
    expect(nano.displayColumnFor(0, 0)).toBe(0);
    expect(nano.displayColumnFor(0, 4)).toBe(4);
  });

  it('un caractère de contrôle avant la colonne cible décale la position affichée (^A = 2 colonnes)', () => {
    const content = 'x\x01eth0\n'; // displayContent: "x^Aeth0"
    const fs = new InMemoryEditorFsContext({ '/tmp/ctrl.txt': content });
    const nano = new NanoEngine(fs, '/tmp/ctrl.txt', content, false);
    // Raw column 2 is "e" of "eth0" -- but ^A eats 2 display columns for 1 raw column.
    expect(nano.displayColumnFor(0, 2)).toBe(3);
  });

  it('sur une ligne différente de la ligne 0, ne compte que les caractères de CETTE ligne', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'aaaa\nbbbb\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'aaaa\nbbbb\n', false);
    expect(nano.displayColumnFor(1, 2)).toBe(2);
  });
});

describe('Scénario — pendingReplaceMatch fournit tout ce qu\'il faut pour surligner l\'occurrence', () => {
  it('les colonnes du match, converties via displayColumnFor, encadrent exactement le texte trouvé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'eth0 up\neth1 up\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'eth0 up\neth1 up\n', false);
    ctrl(nano, '\\');
    typeText(nano, 'eth');
    press(nano, 'Enter');
    typeText(nano, 'ens');
    press(nano, 'Enter');

    const m = nano.pendingReplaceMatch!;
    expect(m).not.toBeNull();
    expect(m.line).toBe(0);
    const startCol = nano.displayColumnFor(m.line, m.start);
    const endCol = nano.displayColumnFor(m.line, m.end);
    expect(nano.lines[m.line].slice(startCol, endCol)).toBe('eth');
  });
});
