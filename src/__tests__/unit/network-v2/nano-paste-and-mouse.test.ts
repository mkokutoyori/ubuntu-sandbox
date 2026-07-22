/**
 * Nano — coller depuis le presse-papiers du navigateur et cliquer dans
 * le texte pour repositionner le curseur.
 *
 * Le textarea affiche `displayContent` (notation `^X` pour les octets de
 * contrôle), donc un clic souris — dont `selectionStart` est un offset
 * dans le texte AFFICHÉ — doit être reconverti vers la position réelle
 * (ligne, colonne) du buffer avant de toucher `linesArr`. `applyPaste`
 * simule un collage sans "bracketed paste" : chaque caractère atterrit
 * comme s'il avait été tapé très vite (un `\n` collé crée une nouvelle
 * ligne, comme Enter), en UN SEUL pas d'annulation.
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
function alt(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { alt: true }));
}

describe('Scénario — coller un bloc multi-lignes dans le buffer (édition)', () => {
  it('un texte collé avec des \\n insère de nouvelles lignes, exactement comme Enter', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'start\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'start\n', false);
    nano.applyPaste('nameserver 8.8.8.8\nnameserver 1.1.1.1\n# commentaire\n');
    expect(nano.lines).toEqual([
      'nameserver 8.8.8.8',
      'nameserver 1.1.1.1',
      '# commentaire',
      'start',
    ]);
    expect(nano.modified).toBe(true);
  });

  it('le curseur se retrouve à la fin du texte collé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'abc\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'abc\n', false);
    nano.applyPaste('X\nYZ');
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(2);
    expect(nano.lines).toEqual(['X', 'YZabc']);
  });

  it('un collage au milieu d\'une ligne coupe correctement le texte existant', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'helloworld\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'helloworld\n', false);
    for (let i = 0; i < 5; i++) press(nano, 'ArrowRight');
    nano.applyPaste(' BIG ');
    expect(nano.lines).toEqual(['hello BIG world']);
  });

  it('un collage contenant une tabulation insère \\t littéral (contrairement à la touche Tab, non liée)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('a\tb');
    expect(nano.lines).toEqual(['a\tb']);
  });

  it('gère \\r\\n (presse-papiers Windows) comme un simple saut de ligne', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('a\r\nb');
    expect(nano.lines).toEqual(['a', 'b']);
  });

  it('le collage entier est UN SEUL pas d\'annulation (Alt+U l\'annule intégralement, pas ligne par ligne)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('line1\nline2\nline3');
    expect(nano.lines).toEqual(['line1', 'line2', 'line3']);
    alt(nano, 'u');
    expect(nano.lines).toEqual(['']);
    expect(nano.modified).toBe(false);
  });

  it('coller puis taper un caractère : la frappe démarre un NOUVEAU pas d\'annulation (pas fondue avec le collage)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': '\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', '\n', false);
    nano.applyPaste('AB');
    typeText(nano, 'C');
    expect(nano.lines).toEqual(['ABC']);
    alt(nano, 'u'); // undoes only the "C" keystroke
    expect(nano.lines).toEqual(['AB']);
    alt(nano, 'u'); // undoes the whole paste
    expect(nano.lines).toEqual(['']);
  });

  it('mode vue (-v) : le collage est ignoré, le buffer reste inchangé', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'original\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'original\n', false, true);
    nano.applyPaste('HACKED');
    expect(nano.lines).toEqual(['original']);
    expect(nano.modified).toBe(false);
  });
});

describe('Scénario — coller dans les prompts (recherche, remplacement, nom de fichier)', () => {
  it('coller dans le prompt "Where Is" (^W) remplit le champ de recherche', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'foo bar\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'foo bar\n', false);
    ctrl(nano, 'w');
    nano.applyPaste('bar');
    expect(nano.searchQuery).toBe('bar');
  });

  it('un collage multi-lignes dans un prompt ne garde que la première ligne (champ mono-ligne)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'o'); // save-prompt
    nano.applyPaste('/tmp/first.txt\nrest ignoré');
    expect(nano.saveFileName).toBe('/tmp/x.txt/tmp/first.txt');
  });
});

describe('Scénario — clic souris repositionne le curseur (offset display → (ligne, colonne) réelle)', () => {
  it('cliquer sur un offset simple (aucun caractère de contrôle) déplace le curseur exactement', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'hello\nworld\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'hello\nworld\n', false);
    // "hello\nworld" -- offset 8 is the "r" in "world" (line 1, col 2).
    nano.moveCursorToDisplayOffset(8);
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(2);
  });

  it('un offset au-delà de la dernière ligne clampe en fin de buffer', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ab\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ab\n', false);
    nano.moveCursorToDisplayOffset(999);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(2);
  });

  it('un caractère de contrôle avant le point de clic (^A = 2 colonnes affichées) décale le mapping vers la position réelle', () => {
    const content = 'x\x01y\n'; // displayContent: "x^Ay" (4 display chars, 3 raw chars)
    const fs = new InMemoryEditorFsContext({ '/tmp/ctrl.txt': content });
    const nano = new NanoEngine(fs, '/tmp/ctrl.txt', content, false);
    expect(nano.displayContent).toBe('x^Ay');
    // Display offset 3 is right after "^A" (2 display chars) + "x" (1) = the "y".
    nano.moveCursorToDisplayOffset(3);
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(2); // raw column of "y" -- NOT 3
  });

  it('displayCursorOffset est l\'inverse exact de moveCursorToDisplayOffset pour un aller-retour', () => {
    const content = 'ab\x01cd\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/ctrl2.txt': content });
    const nano = new NanoEngine(fs, '/tmp/ctrl2.txt', content, false);
    for (const target of [0, 1, 2, 4, 5, 6]) {
      nano.moveCursorToDisplayOffset(target);
      expect(nano.displayCursorOffset).toBe(target);
    }
  });

  it('un clic ne fait rien hors du mode édition (ex: pendant un prompt de recherche)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'hello\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'hello\n', false);
    ctrl(nano, 'w');
    nano.moveCursorToDisplayOffset(3);
    expect(nano.mode).toBe('search'); // still in the prompt
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(0); // buffer cursor untouched
  });

  it('après un clic, la frappe suivante démarre un nouveau pas d\'annulation (comme les flèches)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'ab\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'ab\n', false);
    typeText(nano, 'X');
    nano.moveCursorToDisplayOffset(0);
    typeText(nano, 'Y');
    alt(nano, 'u'); // undoes only "Y"
    expect(nano.lines).toEqual(['Xab']);
  });
});
